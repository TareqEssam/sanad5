/* ===========================================================================
   سند — نواة «المرآة» المحلية (V20.7 + أساس V20.8)
   ---------------------------------------------------------------------------
   المبدأ: لا نموذج خارجي، لا تنزيل أوزان، لا شبكة أثناء الفحص.
   كل القياسات تُحسب من بكسلات الصورة داخل المتصفح (رياضيات JS خالصة).

   المخرجات دائماً تحمل: state (ok | attention | unknown) وconfidence وaction،
   لأن «الحكم بلا ثقة» أسوأ من «الامتناع».
   =========================================================================== */
(function (global) {
  'use strict';

  /* ------------------------------------------------------------------ */
  /* أدوات عامة                                                          */
  /* ------------------------------------------------------------------ */
  function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }

  function medianOf(arr) {
    if (!arr.length) return 0;
    var a = Array.prototype.slice.call(arr).sort(function (x, y) { return x - y; });
    var m = a.length >> 1;
    return (a.length % 2) ? a[m] : (a[m - 1] + a[m]) / 2;
  }
  function meanOf(arr) {
    if (!arr.length) return 0;
    var s = 0;
    for (var i = 0; i < arr.length; i++) s += arr[i];
    return s / arr.length;
  }
  function stdevOf(arr) {
    if (arr.length < 2) return 0;
    var m = meanOf(arr), s = 0;
    for (var i = 0; i < arr.length; i++) { var d = arr[i] - m; s += d * d; }
    return Math.sqrt(s / (arr.length - 1));
  }
  function arNum(n) {
    var words = ['صفر', 'واحد', 'اثنان', 'ثلاثة', 'أربعة', 'خمسة', 'ستة', 'سبعة', 'ثمانية', 'تسعة', 'عشرة'];
    return (n >= 0 && n < words.length) ? words[n] : String(n);
  }

  function clipRect(x, y, w, h, W, H) {
    var x0 = Math.max(0, Math.round(x)), y0 = Math.max(0, Math.round(y));
    var x1 = Math.min(W, Math.round(x + w)), y1 = Math.min(H, Math.round(y + h));
    return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
  }
  function rectArea(r) { return r ? r.w * r.h : 0; }

  function regionLuma(work, r) {
    if (!r || r.w < 2 || r.h < 2) return null;
    var vals = [], y, x, i;
    for (y = r.y; y < r.y + r.h; y++) {
      for (x = r.x; x < r.x + r.w; x++) { i = y * work.w + x; vals.push(work.luma[i]); }
    }
    if (!vals.length) return null;
    return {
      count: vals.length, mean: meanOf(vals), median: medianOf(vals),
      stdev: stdevOf(vals), min: Math.min.apply(null, vals), max: Math.max.apply(null, vals)
    };
  }

  /* ------------------------------------------------------------------ */
  /* 1) بناء صورة العمل (Luma / Cb / Cr)                                   */
  /* ------------------------------------------------------------------ */
  function buildWorkFromImageData(img, w, h, canvas) {
    var d = img.data, n = w * h;
    var luma = new Float32Array(n), cb = new Float32Array(n), cr = new Float32Array(n);
    var R = new Uint8Array(n), G = new Uint8Array(n), B = new Uint8Array(n);
    for (var p = 0, i = 0; i < d.length; i += 4, p++) {
      var r = d[i], g = d[i + 1], b = d[i + 2];
      R[p] = r; G[p] = g; B[p] = b;
      luma[p] = 0.299 * r + 0.587 * g + 0.114 * b;
      cb[p] = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
      cr[p] = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
    }
    return { w: w, h: h, luma: luma, cb: cb, cr: cr, R: R, G: G, B: B, canvas: canvas || null };
  }

  function sourceSize(source) {
    if (!source) return { w: 0, h: 0 };
    var w = source.videoWidth || source.naturalWidth || source.width || 0;
    var h = source.videoHeight || source.naturalHeight || source.height || 0;
    return { w: w, h: h };
  }

  function buildWorkingImage(source, maxDim, workCanvas) {
    var sz = sourceSize(source);
    if (!sz.w || !sz.h) throw new Error('لا يوجد إطار صورة صالح');
    var s = Math.min(1, maxDim / Math.max(sz.w, sz.h));
    var w = Math.max(1, Math.round(sz.w * s)), h = Math.max(1, Math.round(sz.h * s));
    var c = workCanvas || (global.document && global.document.createElement('canvas'));
    if (!c) throw new Error('لا يمكن إنشاء لوحة رسم');
    c.width = w; c.height = h;
    var ctx = c.getContext('2d', { willReadFrequently: true, alpha: false });
    if (!ctx) throw new Error('تعذّر سياق الرسم');
    ctx.drawImage(source, 0, 0, w, h);
    var img = ctx.getImageData(0, 0, w, h);
    return buildWorkFromImageData(img, w, h, c);
  }

  /* ------------------------------------------------------------------ */
  /* 2) كشف الوجه: FaceDetector المدمج ثم بديل بلون البشرة النسبي         */
  /* ------------------------------------------------------------------ */
  function detectFaceBoxNative(source) {
    if (!global.FaceDetector) return Promise.resolve(null);
    var sz = sourceSize(source);
    if (!sz.w || !sz.h) return Promise.resolve(null);
    var det;
    try { det = new global.FaceDetector({ fastMode: true, maxDetectedFaces: 1 }); }
    catch (e) { return Promise.resolve(null); }
    return det.detect(source).then(function (faces) {
      if (!faces || !faces.length) return null;
      var b = faces[0].boundingBox;
      if (!b || !(b.width > 8 && b.height > 8)) return null;
      return {
        nx: b.x / sz.w, ny: b.y / sz.h, nw: b.width / sz.w, nh: b.height / sz.h,
        conf: 0.9, src: 'native'
      };
    }).catch(function () { return null; });
  }

  /* المئين: قيمة تحت نسبة محددة من قائمة مرتبة */
  function percentileOf(sorted, p) {
    if (!sorted.length) return 0;
    var idx = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)));
    return sorted[idx];
  }

  /* قناع البشرة: العتبة تُشتق من أعلى ألوان الدفء في وسط الإطار،
     فلا تدخل الشعر الداكن ولا البارد، وتبقى عتبات نسبية لا مطلقة. */
  function buildSkinMask(work, region) {
    var w = work.w, h = work.h, n = w * h;
    var cx0 = region ? Math.floor(w * region.x0) : Math.floor(w * 0.30);
    var cx1 = region ? Math.ceil(w * region.x1) : Math.ceil(w * 0.70);
    var cy0 = region ? Math.floor(h * region.y0) : Math.floor(h * 0.20);
    var cy1 = region ? Math.ceil(h * region.y1) : Math.ceil(h * 0.70);
    var diffs = [], y, x, i;
    for (y = cy0; y < cy1; y++) {
      for (x = cx0; x < cx1; x++) { i = y * w + x; diffs.push(work.cr[i] - work.cb[i]); }
    }
    diffs.sort(function (a, b) { return a - b; });
    var p90 = percentileOf(diffs, 0.90);
    var thr;
    if (p90 >= 15) {
      /* المنطقة فيها نسبة معقولة من البشرة: العتبة النسبية تكفي */
      thr = Math.max(8, Math.min(32, p90 * 0.50));
    } else {
      /* المنطقة فيها نسبة قليلة من البشرة (لقطة جسم كامل: الوجه صغير في الأعلى):
         نرفع العتبة إلى مستوى دفء البشرة لنلتقط الوجه ونستبعد الشعر */
      thr = Math.max(14, Math.min(32, percentileOf(diffs, 0.99) * 0.45));
    }
    var mask = new Uint8Array(n);
    for (i = 0; i < n; i++) {
      if (work.luma[i] > 28 && (work.cr[i] - work.cb[i]) >= thr) mask[i] = 1;
    }
    return mask;
  }

  /* أكبر كتلة متصلة في قناع (على شبكة مخفّضة) */
  function largestBlob(work, mask, scale) {
    scale = scale || 8;
    var gw = Math.ceil(work.w / scale), gh = Math.ceil(work.h / scale);
    var grid = new Uint8Array(gw * gh), gy, gx, x, y;
    for (gy = 0; gy < gh; gy++) {
      for (gx = 0; gx < gw; gx++) {
        x = Math.min(work.w - 1, gx * scale + (scale >> 1));
        y = Math.min(work.h - 1, gy * scale + (scale >> 1));
        grid[gy * gw + gx] = mask[y * work.w + x];
      }
    }
    var seen = new Uint8Array(gw * gh), best = null;
    var stack = new Int32Array(gw * gh);
    for (var start = 0; start < grid.length; start++) {
      if (!grid[start] || seen[start]) continue;
      var sp = 0; stack[sp++] = start; seen[start] = 1;
      var count = 0, minx = 1e9, maxx = -1, miny = 1e9, maxy = -1;
      while (sp > 0) {
        var cur = stack[--sp], cxx = cur % gw, cyy = (cur / gw) | 0;
        count++;
        if (cxx < minx) minx = cxx; if (cxx > maxx) maxx = cxx;
        if (cyy < miny) miny = cyy; if (cyy > maxy) maxy = cyy;
        var nb = [cur - 1, cur + 1, cur - gw, cur + gw];
        for (var k = 0; k < 4; k++) {
          var q = nb[k];
          if (q < 0 || q >= grid.length) continue;
          if (k < 2) { if (Math.abs((q % gw) - cxx) !== 1) continue; }
          else { if (Math.abs(((q / gw) | 0) - cyy) !== 1) continue; }
          if (grid[q] && !seen[q]) { seen[q] = 1; stack[sp++] = q; }
        }
      }
      if (!best || count > best.count) {
        best = {
          count: count, x: minx * scale, y: miny * scale,
          w: (maxx - minx + 1) * scale, h: (maxy - miny + 1) * scale
        };
      }
    }
    if (!best) return null;
    best.x = Math.max(0, Math.min(work.w - 1, best.x));
    best.y = Math.max(0, Math.min(work.h - 1, best.y));
    best.w = Math.min(best.w, work.w - best.x);
    best.h = Math.min(best.h, work.h - best.y);
    best.area = best.count * scale * scale;
    return best;
  }

  /* تسمية المكوّنات المتصلة في قناع ثنائي */
  function labelComponents(mask, w, h) {
    var n = w * h, labels = new Int32Array(n), comps = [], stack = new Int32Array(n);
    for (var i = 0; i < n; i++) labels[i] = -1;
    for (var start = 0; start < n; start++) {
      if (!mask[start] || labels[start] >= 0) continue;
      var id = comps.length, sp = 0;
      stack[sp++] = start; labels[start] = id;
      var pix = [];
      while (sp > 0) {
        var cur = stack[--sp];
        pix.push(cur);
        var cx = cur % w, cy = (cur / w) | 0;
        var nb = [cur - 1, cur + 1, cur - w, cur + w];
        for (var k = 0; k < 4; k++) {
          var q = nb[k];
          if (q < 0 || q >= n) continue;
          if (k < 2) { if (Math.abs((q % w) - cx) !== 1) continue; }
          else { if (Math.abs(((q / w) | 0) - cy) !== 1) continue; }
          if (mask[q] && labels[q] < 0) { labels[q] = id; stack[sp++] = q; }
        }
      }
      comps.push({ id: id, pixels: pix, area: pix.length });
    }
    return { labels: labels, comps: comps };
  }

  function bboxOf(work, pixels) {
    var minx = work.w, maxx = -1, miny = work.h, maxy = -1;
    for (var i = 0; i < pixels.length; i++) {
      var p = pixels[i], x = p % work.w, y = (p / work.w) | 0;
      if (x < minx) minx = x; if (x > maxx) maxx = x;
      if (y < miny) miny = y; if (y > maxy) maxy = y;
    }
    return { x: minx, y: miny, w: maxx - minx + 1, h: maxy - miny + 1 };
  }

  /* كشف الوجه: مكوّنات البشرة + كشف «الثقب» (الوجه داخل حلقة الشعر) + ترجيح */
  function detectFaceBoxBySkin(work) {
    var w = work.w, h = work.h, n = w * h, frameArea = n;
    /* ثلاث مناطق: وسط الكادر (سيلفي)، ثم أعلى الكادر (لقطة جسم كامل)، ثم الإطار كله */
    var tries = [null,
      { x0: 0.24, x1: 0.76, y0: 0.02, y1: 0.45 },
      { x0: 0.10, x1: 0.90, y0: 0.00, y1: 1.00 }];
    for (var ti = 0; ti < tries.length; ti++) {
      var got = detectFaceInSkinMask(work, buildSkinMask(work, tries[ti]));
      if (got) return got;
    }
    return null;
  }

  function detectFaceInSkinMask(work, skin) {
    var w = work.w, h = work.h, n = w * h, frameArea = n;
    var lab = labelComponents(skin, w, h);
    var best = null;
    for (var ci = 0; ci < lab.comps.length; ci++) {
      var comp = lab.comps[ci];
      if (comp.area < frameArea * 0.004) continue;
      var bb = bboxOf(work, comp.pixels);
      /* الثقب: بكسلات غير بشرية محصورة داخل المكوّن ولا تتصل بالخارج */
      var pad = 2;
      var rx0 = Math.max(0, bb.x - pad), ry0 = Math.max(0, bb.y - pad);
      var rx1 = Math.min(w, bb.x + bb.w + pad), ry1 = Math.min(h, bb.y + bb.h + pad);
      var rw = rx1 - rx0, rh = ry1 - ry0;
      if (rw < 4 || rh < 4) continue;
      var visit = new Uint8Array(rw * rh);
      var q = [];
      function pushIf(x, y) {
        if (x < rx0 || x >= rx1 || y < ry0 || y >= ry1) return;
        var idx = (y - ry0) * rw + (x - rx0);
        if (visit[idx]) return;
        if (skin[y * w + x]) return;
        visit[idx] = 1; q.push(y * w + x);
      }
      for (var x = rx0; x < rx1; x++) { pushIf(x, ry0); pushIf(x, ry1 - 1); }
      for (var y = ry0; y < ry1; y++) { pushIf(rx0, y); pushIf(rx1 - 1, y); }
      while (q.length) {
        var cur = q.pop();
        var cx = cur % w, cy = (cur / w) | 0;
        pushIf(cx - 1, cy); pushIf(cx + 1, cy); pushIf(cx, cy - 1); pushIf(cx, cy + 1);
      }
      var holePix = [];
      for (var yy = ry0; yy < ry1; yy++) {
        for (var xx = rx0; xx < rx1; xx++) {
          if (!visit[(yy - ry0) * rw + (xx - rx0)]) holePix.push(yy * w + xx);
        }
      }
      var cand = bb, fill = comp.area / Math.max(1, bb.w * bb.h);
      var usedHole = false, candPix = null;
      if (holePix.length > comp.area * 0.25 && holePix.length > frameArea * 0.004) {
        /* حلقة شعر حول وجه: الوجه هو الثقب الداخلي */
        cand = bboxOf(work, holePix);
        fill = holePix.length / Math.max(1, cand.w * cand.h);
        usedHole = true; candPix = holePix;
      } else {
        candPix = [];
        for (var ci2 = 0; ci2 < comp.pixels.length; ci2++) {
          var pixIdx = comp.pixels[ci2];
          var pi = pixIdx % w, pj = (pixIdx / w) | 0;
          if (pi >= cand.x && pi < cand.x + cand.w && pj >= cand.y && pj < cand.y + cand.h) candPix.push(pixIdx);
        }
      }
      /* درجة "شبه البشرة": دافئة (Cr-Cb كبير) وفاتحة الإضاءة —
         الشعر الداكن لا يحقق الشرطين معاً */
      var skinLike = 0;
      for (var si = 0; si < candPix.length; si++) {
        var sx = candPix[si];
        if ((work.cr[sx] - work.cb[sx]) >= 15 && work.luma[sx] >= 55) skinLike++;
      }
      skinLike = candPix.length ? skinLike / candPix.length : 0;
      var aspect = cand.w / Math.max(1, cand.h);
      if (aspect < 0.42 || aspect > 1.85) continue;
      var areaFrac = (cand.w * cand.h) / frameArea;
      /* حد أدنى منخفض: في لقطة الجسم الكامل يكون الوجه صغيراً (والمستخدم بعيداً) */
      if (areaFrac < 0.0035 || areaFrac > 0.70) continue;
      var ccx = (cand.x + cand.w / 2) / w, ccy = (cand.y + cand.h / 2) / h;
      if (ccx < 0.18 || ccx > 0.82) continue;
      if (ccy < 0.05 || ccy > 0.72) continue;
      if (!usedHole && skinLike < 0.30) continue;
      var score = 1.0;
      score += 1.4 * skinLike;
      score -= 1.2 * Math.abs(aspect - 0.75);
      score -= 1.6 * Math.abs(ccx - 0.5);
      /* الوجه كتلة ممتلئة: حلقة الشعر حوله أقل امتلاءً */
      score -= (fill >= 0.72 ? 0 : (0.72 - fill) * 2.2);
      if (ccy < 0.15) score -= (0.15 - ccy) * 4;
      if (ccy > 0.60) score -= (ccy - 0.60) * 4;
      if (fill < 0.35) score -= 0.8;
      if (!best || score > best.score) {
        best = { x: cand.x, y: cand.y, w: cand.w, h: cand.h, conf: 0.42, src: 'skin', score: score };
      }
    }
    return best;
  }

  /* ------------------------------------------------------------------ */
  /* 3) نموذج المناطق التشريحية (نسبية إلى صندوق الوجه)                   */
  /* ------------------------------------------------------------------ */
  function buildRegions(box, w, h) {
    if (!box) return null;
    var bx = box.x, by = box.y, bw = box.w, bh = box.h;
    return {
      crown: clipRect(bx - 0.40 * bw, by - 0.95 * bh, bw * 1.80, bh * 0.95, w, h),
      sideL: clipRect(bx - 0.34 * bw, by - 0.10 * bh, 0.34 * bw, 0.70 * bh, w, h),
      sideR: clipRect(bx + bw, by - 0.10 * bh, 0.34 * bw, 0.70 * bh, w, h),
      brow: clipRect(bx, by + 0.16 * bh, bw, 0.28 * bh, w, h),
      midFace: clipRect(bx, by + 0.44 * bh, bw, 0.30 * bh, w, h),
      cheek: clipRect(bx + bw * 0.05, by + 0.30 * bh, bw * 0.90, 0.14 * bh, w, h),
      jaw: clipRect(bx, by + 0.55 * bh, bw, 0.60 * bh, w, h),
      neck: clipRect(bx - 0.15 * bw, by + 1.05 * bh, bw * 1.30, 0.55 * bh, w, h),
      torso: clipRect(bx - 0.40 * bw, by + 1.55 * bh, bw * 1.80, h - (by + 1.55 * bh), w, h)
    };
  }

  /* ------------------------------------------------------------------ */
  /* 4) التدرجات وتوتر البنية                                            */
  /* ------------------------------------------------------------------ */
  /* تدرجات Sobel قياسية: أفقي = اليمين−اليسار، رأسي = الأعلى−الأسفل */
  function computeGradients(work) {
    var w = work.w, h = work.h, luma = work.luma, n = w * h;
    var gx = new Float32Array(n), gy = new Float32Array(n);
    for (var y = 1; y < h - 1; y++) {
      for (var x = 1; x < w - 1; x++) {
        var i = y * w + x;
        var a = luma[i - w - 1], b = luma[i - w], c = luma[i - w + 1];
        var d = luma[i - 1], f = luma[i + 1];
        var g = luma[i + w - 1], h2 = luma[i + w], k = luma[i + w + 1];
        gx[i] = ((c + 2 * f + k) - (a + 2 * d + g)) / 8;
        gy[i] = ((a + 2 * b + c) - (g + 2 * h2 + k)) / 8;
      }
    }
    return { gx: gx, gy: gy };
  }

  function boxSum3(src, w, h) {
    var tmp = new Float32Array(w * h), out = new Float32Array(w * h);
    var y, x, i, s;
    for (y = 0; y < h; y++) {
      for (x = 0; x < w; x++) {
        i = y * w + x;
        s = src[i];
        if (x > 0) s += src[i - 1];
        if (x < w - 1) s += src[i + 1];
        tmp[i] = s;
      }
    }
    for (y = 0; y < h; y++) {
      for (x = 0; x < w; x++) {
        i = y * w + x;
        s = tmp[i];
        if (y > 0) s += tmp[i - w];
        if (y < h - 1) s += tmp[i + w];
        out[i] = s;
      }
    }
    return out;
  }

  function computeTensor(work, grad) {
    var w = work.w, h = work.h, n = w * h;
    var jxx = new Float32Array(n), jyy = new Float32Array(n), jxy = new Float32Array(n), i;
    for (i = 0; i < n; i++) {
      jxx[i] = grad.gx[i] * grad.gx[i];
      jyy[i] = grad.gy[i] * grad.gy[i];
      jxy[i] = grad.gx[i] * grad.gy[i];
    }
    return {
      jxx: boxSum3(jxx, w, h), jyy: boxSum3(jyy, w, h), jxy: boxSum3(jxy, w, h)
    };
  }

  /* ------------------------------------------------------------------ */
  /* 5) فلاتر الحد الأدنى/الأقصى 3×3                                      */
  /* ------------------------------------------------------------------ */
  function morph3(src, w, h, isMax) {
    var tmp = new Float32Array(w * h), out = new Float32Array(w * h);
    var y, x, i, s, a, b, c;
    for (y = 0; y < h; y++) {
      for (x = 0; x < w; x++) {
        i = y * w + x;
        a = src[i]; b = src[x > 0 ? i - 1 : i]; c = src[x < w - 1 ? i + 1 : i];
        tmp[i] = isMax ? Math.max(a, b, c) : Math.min(a, b, c);
      }
    }
    for (y = 0; y < h; y++) {
      for (x = 0; x < w; x++) {
        i = y * w + x;
        a = tmp[i]; b = tmp[y > 0 ? i - w : i]; c = tmp[y < h - 1 ? i + w : i];
        out[i] = isMax ? Math.max(a, b, c) : Math.min(a, b, c);
      }
    }
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* 6) وحدة التأطير                                                      */
  /* ------------------------------------------------------------------ */
  function checkFraming(work, box, regions) {
    var res = { id: 'framing', title: 'تأطير الصورة', state: 'ok', confidence: 0.8, text: '', action: '', evidence: '' };
    if (!box || !regions) {
      res.state = 'unknown'; res.confidence = 0.2;
      res.text = 'لم أتمكّن من تحديد موقع وجهك في الإطار.';
      res.action = 'ضع وجهك في وسط الكادر على بعد ذراع من الهاتف.';
      res.evidence = 'لم يُعثر على وجه';
      return res;
    }
    var cx = (box.x + box.w / 2) / work.w;
    var faceH = box.h / work.h;
    var msgs = [], acts = [], conf = 0.85;
    if (cx < 0.32) {
      msgs.push('وجهك قريب من حافة اليسار في الصورة.');
      acts.push('حرّك الهاتف قليلاً نحو اليمين حتى يتوسط وجهك.');
      conf = Math.min(conf, 0.6);
    } else if (cx > 0.68) {
      msgs.push('وجهك قريب من حافة اليمين في الصورة.');
      acts.push('حرّك الهاتف قليلاً نحو اليسار حتى يتوسط وجهك.');
      conf = Math.min(conf, 0.6);
    }
    if (faceH > 0.68) {
      msgs.push('وجهك يملأ الإطار تقريباً.');
      acts.push('أبعد الهاتف قليلاً حتى يظهر شعرك كاملاً.');
      conf = Math.min(conf, 0.55);
    }
    if (box.y < work.h * 0.012) {
      msgs.push('أعلى وجهك خارج الإطار.');
      acts.push('ارفع الهاتف قليلاً أو ابتعد خطوة حتى يظهر أعلى رأسك.');
      conf = Math.min(conf, 0.5);
    }
    if (!msgs.length) {
      res.text = 'تأطير الصورة مناسب، ووجهك في المنتصف.';
      res.evidence = 'مركز الوجه ' + Math.round(cx * 100) + ' بالمئة، وارتفاع الوجه ' + Math.round(faceH * 100) + ' بالمئة';
    } else {
      res.state = 'attention';
      res.text = msgs.join(' ');
      res.action = acts.join(' ');
      res.evidence = 'مركز الوجه ' + Math.round(cx * 100) + ' بالمئة';
    }
    res.confidence = conf;
    return res;
  }

  /* ------------------------------------------------------------------ */
  /* 7) وحدة الإضاءة                                                     */
  /* ------------------------------------------------------------------ */
  function checkLighting(work, box) {
    var res = { id: 'lighting', title: 'الإضاءة', state: 'ok', confidence: 0.75, text: '', action: '', evidence: '' };
    if (!box) {
      res.state = 'unknown'; res.confidence = 0.15;
      res.text = 'لا يمكن قياس الإضاءة قبل تحديد وجهك.';
      return res;
    }
    var inner = clipRect(box.x + box.w * 0.20, box.y + box.h * 0.22, box.w * 0.60, box.h * 0.56, work.w, work.h);
    var st = regionLuma(work, inner);
    if (!st) { res.state = 'unknown'; res.confidence = 0.15; return res; }
    var leftR = clipRect(box.x + box.w * 0.22, box.y + box.h * 0.25, box.w * 0.26, box.h * 0.50, work.w, work.h);
    var rightR = clipRect(box.x + box.w * 0.52, box.y + box.h * 0.25, box.w * 0.26, box.h * 0.50, work.w, work.h);
    var sl = regionLuma(work, leftR), sr = regionLuma(work, rightR);
    var balance = (sl && sr) ? Math.abs(sl.median - sr.median) : 0;
    var msgs = [], acts = [], conf = 0.8;

    if (st.median < 46) {
      res.state = 'attention'; msgs.push('الإضاءة على وجهك ضعيفة جداً.');
      acts.push('قف مقابل نافذة أو مصباح، ثم أعد الفحص.'); conf = 0.6;
    } else if (st.median < 78) {
      res.state = 'attention'; msgs.push('الإضاءة على وجهك خافتة.');
      acts.push('وجّه مصدر الضوء نحو وجهك مباشرة.'); conf = 0.65;
    } else if (st.median > 226) {
      res.state = 'attention'; msgs.push('الصورة ساطعة جداً على وجهك.');
      acts.push('ابتعد قليلاً عن مصدر الضوء المباشر.'); conf = 0.6;
    }
    if (balance > 26) {
      res.state = 'attention';
      msgs.push('النور يأتي من جهة واحدة، فنصف وجهك مظلم.');
      acts.push('أدر رأسك قليلاً نحو مصدر الضوء أو غيّر زاوية الهاتف.');
      conf = Math.min(conf, 0.55);
    }
    var forehead = clipRect(box.x + box.w * 0.25, box.y + box.h * 0.05, box.w * 0.50, box.h * 0.22, work.w, work.h);
    var glare = 0, fc = 0, fi, y, x;
    for (y = forehead.y; y < forehead.y + forehead.h; y++) {
      for (x = forehead.x; x < forehead.x + forehead.w; x++) {
        fi = y * work.w + x; fc++;
        if (work.luma[fi] > 238) glare++;
      }
    }
    var glareRatio = fc ? glare / fc : 0;
    if (glareRatio > 0.06) {
      res.state = 'attention';
      msgs.push('توجد لمعة قوية على جبهتك من مصدر الضوء.');
      acts.push('غيّر زاوية الهاتف قليلاً لتقلّ اللمعة.');
      conf = Math.min(conf, 0.5);
    }
    res.confidence = conf;
    res.evidence = 'سطوع الوجه ' + Math.round(st.median) +
      '، فرق جهتي الوجه ' + Math.round(balance) +
      '، لمعان الجبهة ' + Math.round(glareRatio * 100) + ' بالمئة';
    if (msgs.length) { res.text = msgs.join(' '); res.action = acts.join(' '); }
    else { res.text = 'الإضاءة على وجهك مناسبة ومتوازنة.'; }
    return res;
  }

  /* ------------------------------------------------------------------ */
  /* 8) وحدة الشعر                                                       */
  /* ------------------------------------------------------------------ */
  /* قناع الشعر: ليس بشرة، وأغمق قليلاً من الوجه، ومتصّل بالوجه.          */
  function buildHairMask(work, box, regions, skinMask) {
    var w = work.w, h = work.h, n = w * h;
    var faceSt = regionLuma(work, clipRect(box.x + box.w * 0.2, box.y + box.h * 0.2, box.w * 0.6, box.h * 0.6, work.w, work.h));
    var faceMed = faceSt ? faceSt.median : 110;
    var cand = [];
    var rects = [regions.crown, regions.sideL, regions.sideR];
    var i, x, y, ci;
    var raw = new Uint8Array(n);
    for (ci = 0; ci < rects.length; ci++) {
      var r = rects[ci];
      if (!r || r.w < 4 || r.h < 4) continue;
      for (y = r.y; y < r.y + r.h; y++) {
        for (x = r.x; x < r.x + r.w; x++) {
          i = y * w + x;
          if (skinMask[i]) continue;
          if (work.luma[i] > faceMed * 1.12) continue;
          raw[i] = 1;
        }
      }
    }
    /* بذور: البكسلات الملاصقة لصندوق الوجه (الشعر يلتصق بالوجه) */
    var seeds = [], k;
    var pad = Math.max(3, Math.round(box.w * 0.08));
    var ringRects = [
      clipRect(box.x - pad, box.y - pad, box.w + 2 * pad, pad, w, h),
      clipRect(box.x - pad, box.y + box.h, box.w + 2 * pad, pad, w, h),
      clipRect(box.x - pad, box.y, pad, box.h, w, h),
      clipRect(box.x + box.w, box.y, pad, box.h, w, h)
    ];
    for (k = 0; k < ringRects.length; k++) {
      var rr = ringRects[k];
      for (y = rr.y; y < rr.y + rr.h; y++) {
        for (x = rr.x; x < rr.x + rr.w; x++) {
          i = y * w + x;
          if (raw[i]) seeds.push(i);
        }
      }
    }
    if (!seeds.length) return { mask: new Uint8Array(n), count: 0, faceMed: faceMed };
    /* توسيع من البذور (نفس المكوّن المتصل) */
    var keep = new Uint8Array(n);
    var stack = new Int32Array(n), sp = 0;
    for (k = 0; k < seeds.length; k++) {
      var s = seeds[k];
      if (!keep[s]) { keep[s] = 1; stack[sp++] = s; }
    }
    while (sp > 0) {
      var cur = stack[--sp];
      var cx = cur % w, cy = (cur / w) | 0;
      var nb = [cur - 1, cur + 1, cur - w, cur + w];
      for (k = 0; k < 4; k++) {
        var q = nb[k];
        if (q < 0 || q >= n) continue;
        if (k < 2) { if (Math.abs((q % w) - cx) !== 1) continue; }
        else { if (Math.abs(((q / w) | 0) - cy) !== 1) continue; }
        if (keep[q] || !raw[q]) continue;
        keep[q] = 1; stack[sp++] = q;
      }
    }
    var count = 0;
    for (i = 0; i < n; i++) if (keep[i]) count++;
    return { mask: keep, count: count, faceMed: faceMed };
  }

  function analyzeHair(work, box, regions, skinMask, opts) {
    opts = opts || {};
    var thr = opts.thr || {};
    var flyThr = thr.fly || 0.055;
    var consThr = thr.cons || 0.42;
    var strongThr = thr.strong || 0.52;
    var symThr = thr.sym || 0.16;
    var res = { id: 'hair', title: 'الشعر', state: 'unknown', confidence: 0.2, text: '', action: '', evidence: '', metrics: {} };
    if (!box || !regions) { res.text = 'لا يمكن فحص الشعر قبل تحديد وجهك.'; return res; }

    var hairInfo = buildHairMask(work, box, regions, skinMask);
    res.metrics.hairRatio = hairInfo.count / (work.w * work.h);
    if (hairInfo.count < work.w * work.h * 0.010) {
      res.text = 'لم أتمكّن من تمييز الشعر بوضوح في الصورة.';
      res.action = 'تأكّد من إضاءة رأسك جيداً، وأن يكون الشعر داخل الإطار.';
      res.confidence = 0.2;
      return res;
    }

    var w = work.w, h = work.h, n = w * h;
    var grad = computeGradients(work);
    var tensor = computeTensor(work, grad);
    var mask = hairInfo.mask;

    /* جمع عيّنات داخل قناع الشعر */
    var cos2 = 0, sin2 = 0, cnt = 0, cohSum = 0;
    var histL = new Float64Array(8), histR = new Float64Array(8);
    var splitX = box.x + box.w / 2;
    var idxs = [];
    var i;
    for (i = 0; i < n; i++) if (mask[i]) idxs.push(i);
    if (idxs.length > 24000) {
      var step = Math.ceil(idxs.length / 24000);
      var kept = [];
      for (i = 0; i < idxs.length; i += step) kept.push(idxs[i]);
      idxs = kept;
    }
    var energySample = [];
    for (i = 0; i < idxs.length; i++) {
      var p = idxs[i];
      var jxx = tensor.jxx[p], jyy = tensor.jyy[p], jxy = tensor.jxy[p];
      var tr = jxx + jyy;
      if (tr < 12) continue;
      var coh = ((jxx - jyy) * (jxx - jyy) + 4 * jxy * jxy) / (tr * tr);
      if (coh > 1) coh = 1;
      var th = 0.5 * Math.atan2(2 * jxy, jxx - jyy);
      var two = 2 * th;
      cos2 += Math.cos(two); sin2 += Math.sin(two);
      cohSum += coh; cnt++;
      if (energySample.length < 20000) {
        energySample.push(Math.sqrt(grad.gx[p] * grad.gx[p] + grad.gy[p] * grad.gy[p]));
      }
      var bin = Math.min(7, Math.floor(Math.abs(th) / (Math.PI / 2) * 8));
      if ((p % w) < splitX) histL[bin]++; else histR[bin]++;
    }
    var texFrac = idxs.length ? cnt / idxs.length : 0;
    res.metrics.textureFraction = texFrac;
    if (cnt < 350 || texFrac < 0.10) {
      res.text = 'تفاصيل الشعر في الصورة غير واضحة بما يكفي للحكم.';
      res.action = 'قرّب الهاتف قليلاً نحو رأسك ثم أعد اللقطة.';
      res.action = 'اقترب قليلاً من رأسك أو حسّن الإضاءة.';
      res.confidence = 0.25;
      return res;
    }
    var R = Math.sqrt(cos2 * cos2 + sin2 * sin2) / cnt;
    var coherence = cohSum / cnt;
    res.metrics.coherence = coherence;
    res.metrics.directionConsistency = R;
    res.metrics.samples = cnt;
    res.metrics.edgeMedian = medianOf(energySample);

    /* تناظر نمط التسريح بين جهتي الرأس */
    var sumL = 0, sumR = 0, k;
    for (k = 0; k < 8; k++) { sumL += histL[k]; sumR += histR[k]; }
    var jsd = 0;
    if (sumL > 40 && sumR > 40) {
      for (k = 0; k < 8; k++) {
        var pl = histL[k] / sumL, pr = histR[k] / sumR, ml = (pl + pr) / 2;
        if (ml > 0) {
          jsd += 0.5 * (pl > 0 ? pl * Math.log(pl / ml) : 0) + 0.5 * (pr > 0 ? pr * Math.log(pr / ml) : 0);
        }
      }
    }
    res.metrics.asymmetry = jsd;

    /* خشونة حدّ الشعر: كثافة البكسلات على الحدود ÷ مساحة الشعر */
    var dil = morph3(mask, w, h, true);
    var ero = morph3(mask, w, h, false);
    var boundary = 0, i2;
    for (i2 = 0; i2 < n; i2++) if (mask[i2] && !ero[i2]) boundary++;
    var boundaryDensity = boundary / Math.max(1, hairInfo.count);
    res.metrics.boundaryDensity = boundaryDensity;

    /* امتداد الشعر خارج صندوق الوجه، لكل جهة */
    var minX = w, maxX = 0, minY = h;
    for (i2 = 0; i2 < n; i2++) {
      if (!mask[i2]) continue;
      var px = i2 % w, py = (i2 / w) | 0;
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (py < minY) minY = py;
    }
    var above = (box.y - minY) / Math.max(1, box.h);
    /* هل يُقصّ أعلى الرأس عند حدّ الصورة؟ */
    var cutTop = false, yy2, xx2;
    for (yy2 = 0; yy2 < Math.min(3, h); yy2++) {
      for (xx2 = Math.max(0, box.x - box.w); xx2 < Math.min(w, box.x + box.w * 1.2); xx2++) {
        if (mask[yy2 * w + xx2]) { cutTop = true; break; }
      }
      if (cutTop) break;
    }
    res.metrics.cutTop = cutTop;
    var left = (box.x - minX) / Math.max(1, box.w);
    var right = (maxX - (box.x + box.w)) / Math.max(1, box.w);
    res.metrics.above = above; res.metrics.left = left; res.metrics.right = right;

    /* الخصلات المتطايرة (تقدير): خشونة عالية + امتداد غير متوازن */
    var strayRate = 0;
    if (boundaryDensity > 0.55) strayRate = Math.min(1, (boundaryDensity - 0.55) / 0.6);
    res.metrics.strayRate = strayRate;

    /* الحكم */
    var msgs = [], acts = [], conf = 0.55;
    var extMax = Math.max(above, left, right);
    var extSide = '';
    if (left > right && left === extMax) extSide = 'يمينك';
    else if (right > left && right === extMax) extSide = 'يسارك';
    else if (above === extMax) extSide = 'أعلى رأسك';

    if (R >= strongThr && strayRate < flyThr && jsd <= symThr) {
      res.state = 'ok';
      res.text = 'شعرك يبدو مرتباً ومنتظم الاتجاه من الأمام.';
    } else {
      res.state = 'attention';
      conf = 0.5;
      if (R < consThr) {
        msgs.push('شعرك غير منتظم الاتجاه، ويبدو متطايراً.');
        acts.push('صفِّ شعرك من الأمام ثم أعد الفحص.');
      }
      if (strayRate >= flyThr) {
        msgs.push('الحد الخارجي لشعرك غير منتظم، وقد تكون هناك خصلات متطايرة.');
        acts.push('مرّر مشطك على محيط شعرك لتوحيد الشكل.');
      }
      if (jsd > symThr) {
        msgs.push('نمط تسريحك يختلف بين جهتي رأسك.');
        acts.push('صفِّ الجهة الأقل انتظاماً لتوحيد الشكل.');
      }
      if (cutTop) {
        msgs.push('أعلى رأسك مقصوص في الصورة، فلا أستطيع الحكم على هذا الجزء.');
        acts.push('ارفع الهاتف قليلاً أو ابتعد خطوة لتظهر قمة رأسك.');
      }
      if (extMax > 0.85 && extSide) {
        msgs.push('شعرك يبرز عن رأسك بشكل واضح عند ' + extSide + '.');
        acts.push('اضغط الشعر عند ' + extSide + ' لتثبيته.');
      }
      if (!msgs.length) {
        msgs.push('شعرك يحتاج مراجعة بسيطة.');
        acts.push('راجع شعرك بالمشط ثم أعد الفحص.');
      }
      res.text = msgs.join(' ');
      res.action = acts.join(' ');
    }
    if (!res.action && res.state === 'attention') res.action = 'راجع شعرك بالمشط ثم أعد الفحص.';
    res.confidence = conf;
    res.evidence = 'اتساق الاتجاه ' + R.toFixed(2) +
      '، التماسك ' + coherence.toFixed(2) +
      '، خشونة الحد ' + boundaryDensity.toFixed(2) +
      '، عدم التناظر ' + jsd.toFixed(2) +
      '، امتداد أعلى ' + above.toFixed(2);
    return res;
  }

  /* ------------------------------------------------------------------ */
  /* 9) وحدة النظارة                                                      */
  /* ------------------------------------------------------------------ */
  function analyzeGlasses(work, box, regions) {
    var res = { id: 'glasses', title: 'النظارة', state: 'unknown', confidence: 0.3, text: '', action: '', evidence: '', metrics: {} };
    var band = regions ? regions.brow : null;
    if (!band || rectArea(band) < 300) { res.text = 'منطقة العينين خارج الإطار.'; return res; }
    var faceSt = regionLuma(work, clipRect(box.x + box.w * 0.2, box.y + box.h * 0.2, box.w * 0.6, box.h * 0.6, work.w, work.h));
    var faceMed = faceSt ? faceSt.median : 110;
    var darkThr = faceMed * 0.62;
    var w = work.w, x, y, i;
    var midX = box.x + box.w / 2;

    /* لكل عمود: مركز كتلة البكسلات الداكنة في نطاق العينين */
    var cols = [], darkTotal = 0;
    for (x = band.x; x < band.x + band.w; x++) {
      var sum = 0, cnt = 0;
      for (y = band.y; y < band.y + band.h; y++) {
        i = y * w + x;
        if (work.luma[i] < darkThr) { sum += y; cnt++; }
      }
      darkTotal += cnt;
      cols.push({ x: x, cy: cnt ? sum / cnt : null, n: cnt });
    }
    var bandArea = band.w * band.h;
    var ratio = darkTotal / Math.max(1, bandArea);
    res.metrics.darkRatio = ratio;

    /* وجود النظارة: إطار يمرّ فوق جسر الأنف، أو ذراعان عند طرفي الوجه */
    function darkFraction(r) {
      if (!r || r.w < 2 || r.h < 2) return 0;
      var c = 0, t = 0;
      for (var yy = r.y; yy < r.y + r.h; yy++) {
        for (var xx = r.x; xx < r.x + r.w; xx++) { t++; if (work.luma[yy * w + xx] < darkThr) c++; }
      }
      return t ? c / t : 0;
    }
    var bridge = clipRect(box.x + box.w * 0.41, band.y, box.w * 0.18, band.h, work.w, work.h);
    var templeL = clipRect(box.x - box.w * 0.03, band.y, box.w * 0.13, band.h, work.w, work.h);
    var templeR = clipRect(box.x + box.w * 0.90, band.y, box.w * 0.13, band.h, work.w, work.h);
    var dBridge = darkFraction(bridge), dTL = darkFraction(templeL), dTR = darkFraction(templeR);
    res.metrics.bridge = dBridge;
    var present = dBridge > 0.16 || (dTL > 0.05 && dTR > 0.05);
    res.metrics.present = present;

    if (!present) {
      res.state = 'ok'; res.confidence = 0.4;
      res.text = 'لا يظهر أثر واضح لنظارة على عينيك.';
      res.evidence = 'جسر الأنف: ' + Math.round(dBridge * 100) + ' بالمئة';
      return res;
    }

    /* شريط الإطار: أعلى عدد من البكسلات الداكنة في كل صف */
    function rowProfile(x0, x1) {
      var prof = [];
      for (var yy = band.y; yy < band.y + band.h; yy++) {
        var c = 0;
        for (var xx = x0; xx < x1; xx++) if (work.luma[yy * w + xx] < darkThr) c++;
        prof.push({ y: yy, c: c });
      }
      return prof;
    }
    function bandCenter(prof) {
      var max = 0, j;
      for (j = 0; j < prof.length; j++) if (prof[j].c > max) max = prof[j].c;
      if (max < 3) return null;
      var lo = null, hi = null;
      for (j = 0; j < prof.length; j++) {
        if (prof[j].c >= max * 0.5) { if (lo === null) lo = prof[j].y; hi = prof[j].y; }
      }
      return { top: lo, bottom: hi, center: (lo + hi) / 2, max: max };
    }
    var profL = rowProfile(band.x, Math.max(band.x + 1, Math.round(midX)));
    var profR = rowProfile(Math.round(midX), band.x + band.w);
    var bL = bandCenter(profL), bR = bandCenter(profR);
    var msgs = [], acts = [], conf = 0.45;
    if (bL && bR) {
      var drop = Math.abs(bL.center - bR.center) / Math.max(1, box.h);
      res.metrics.droop = drop;
      res.metrics.bandLeft = bL.center;
      res.metrics.bandRight = bR.center;
      if (drop > 0.055) {
        res.state = 'attention';
        /* النصف الأيسر من الصورة هو يمين المستخدم */
        var lowerSide = bL.center > bR.center ? 'يمينك' : 'يسارك';
        msgs.push('عدسة النظارة عند ' + lowerSide + ' نازلة عن الأخرى.');
        acts.push('اضبط النظارة على معلم أنفك.');
        conf = 0.4;
      }
      /* زاوية الإطار: نأخذ أعلى حدّ داكن متصل في كل عمود داخل الشريط */
      var pts = [];
      for (var px = band.x; px < band.x + band.w; px++) {
        var runTop = null, runLen = 0, yy2;
        for (yy2 = band.y; yy2 < band.y + band.h; yy2++) {
          if (work.luma[yy2 * w + px] < darkThr) {
            if (runTop === null) runTop = yy2;
            runLen++;
          } else {
            if (runLen >= 2 && runTop !== null) { pts.push({ x: px, y: runTop }); break; }
            runTop = null; runLen = 0;
          }
        }
      }
      if (pts.length > band.w * 0.45) {
        var sx = 0, sy = 0, sxx = 0, sxy = 0, m;
        for (m = 0; m < pts.length; m++) { sx += pts[m].x; sy += pts[m].y; sxx += pts[m].x * pts[m].x; sxy += pts[m].x * pts[m].y; }
        var den = pts.length * sxx - sx * sx;
        if (Math.abs(den) > 1e-6) {
          var slope = (pts.length * sxy - sx * sy) / den;
          var ang = Math.atan(slope) * 180 / Math.PI;
          res.metrics.tiltAngle = ang;
          if (Math.abs(ang) > 7) {
            res.state = 'attention';
            msgs.push('نظارتك تبدو مائلة قليلاً.');
            acts.push('عدّل النظارة على أنفك لتصبح مستوية.');
            conf = Math.min(conf, 0.38);
          }
        }
      }
    }
    var brightRatio = 0, bc = 0;
    for (y = band.y; y < band.y + band.h; y++) {
      for (x = band.x; x < band.x + band.w; x++) { bc++; if (work.luma[y * w + x] > 238) brightRatio++; }
    }
    brightRatio = bc ? brightRatio / bc : 0;
    res.metrics.brightRatio = brightRatio;
    if (brightRatio > 0.06) {
      res.state = 'attention';
      msgs.push('يوجد انعكاس قوي على منطقة النظارة.');
      acts.push('غيّر زاوية الهاتف قليلاً للتأكد من عدم وجود أثر على عدستك.');
      conf = Math.min(conf, 0.38);
    }
    res.confidence = conf;
    res.evidence = 'نسبة الداكن ' + Math.round(ratio * 100) + ' بالمئة، الجسر ' + Math.round(dBridge * 100) + ' بالمئة';
    if (msgs.length) { res.text = msgs.join(' '); res.action = acts.join(' '); }
    else { res.state = 'ok'; res.text = 'نظارتك تبدو مستوية على عينيك.'; }
    return res;
  }

  /* ------------------------------------------------------------------ */
  /* 10) وحدة البقع على الملابس                                          */
  /* ------------------------------------------------------------------ */
  /* يملأ المناطق المغلقة داخل القناع (مثل بقعة داخل القميص) */
  function fillHoles(mask, w, h) {
    var n = w * h, out = new Uint8Array(mask), visited = new Uint8Array(n);
    var stack = new Int32Array(n), sp = 0, x, y, i;
    for (x = 0; x < w; x++) {
      if (!mask[x]) { visited[x] = 1; stack[sp++] = x; }
      var b = (h - 1) * w + x; if (!mask[b]) { visited[b] = 1; stack[sp++] = b; }
    }
    for (y = 0; y < h; y++) {
      var l = y * w; if (!mask[l]) { visited[l] = 1; stack[sp++] = l; }
      var r = y * w + w - 1; if (!mask[r]) { visited[r] = 1; stack[sp++] = r; }
    }
    while (sp > 0) {
      var cur = stack[--sp], cx = cur % w, cy = (cur / w) | 0;
      var nb = [cur - 1, cur + 1, cur - w, cur + w];
      for (var k = 0; k < 4; k++) {
        var q = nb[k];
        if (q < 0 || q >= n) continue;
        if (k < 2) { if (Math.abs((q % w) - cx) !== 1) continue; }
        else { if (Math.abs(((q / w) | 0) - cy) !== 1) continue; }
        if (visited[q] || mask[q]) continue;
        visited[q] = 1; stack[sp++] = q;
      }
    }
    for (i = 0; i < n; i++) if (!mask[i] && !visited[i]) out[i] = 1;
    return out;
  }

  /* قناع الملابس: الكتلة الغالبة في أسفل الإطار قرب لون القماش */
  function buildGarmentMask(work, box, rect) {
    var w = work.w, h = work.h, n = w * h, y, x, i;
    var y0 = Math.min(h - 4, Math.max(0, Math.round(box.y + box.h * 1.08)));
    var x0 = Math.round(w * 0.24), x1 = Math.round(w * 0.76);
    var yEnd = h;
    if (rect && rect.w > 12 && rect.h > 12) {
      /* نحدّد الجزء المطلوب (صدر أو بنطال) حتى لا نخلط بين القميص والبنطال */
      y0 = Math.max(0, Math.round(rect.y));
      yEnd = Math.min(h, Math.round(rect.y + rect.h));
      x0 = Math.max(0, Math.round(rect.x + rect.w * 0.12));
      x1 = Math.min(w, Math.round(rect.x + rect.w * 0.88));
      if (yEnd - y0 < 8) { y0 = Math.min(h - 4, Math.max(0, Math.round(box.y + box.h * 1.08))); yEnd = h; x0 = Math.round(w * 0.24); x1 = Math.round(w * 0.76); }
    }
    var cbs = [], crs = [], ls = [];
    for (y = y0; y < yEnd; y++) {
      for (x = x0; x < x1; x++) {
        i = y * w + x;
        if (work.luma[i] > 250 || work.luma[i] < 10) continue;
        cbs.push(128 - 0.1687 * work.R[i] - 0.3313 * work.G[i] + 0.5 * work.B[i]);
        crs.push(128 + 0.5 * work.R[i] - 0.4187 * work.G[i] - 0.0813 * work.B[i]);
        ls.push(work.luma[i]);
      }
    }
    if (cbs.length < 200) return null;
    var medCb = medianOf(cbs), medCr = medianOf(crs), medL = medianOf(ls);
    var cand = new Uint8Array(n);
    for (y = y0; y < yEnd; y++) {
      for (x = 0; x < w; x++) {
        i = y * w + x;
        if (work.luma[i] > 250 || work.luma[i] < 10) continue;
        var cb = 128 - 0.1687 * work.R[i] - 0.3313 * work.G[i] + 0.5 * work.B[i];
        var cr = 128 + 0.5 * work.R[i] - 0.4187 * work.G[i] - 0.0813 * work.B[i];
        var dC = Math.hypot(cb - medCb, cr - medCr), dL = Math.abs(work.luma[i] - medL);
        if (dC < 34 && dL < 52) cand[i] = 1;
      }
    }
    var lab = labelComponents(cand, w, h);
    var best = null, bestScore = -1;
    var bx0 = Math.round(w * 0.40), bx1 = Math.round(w * 0.60), by = Math.round(h * 0.82);
    for (var ci = 0; ci < lab.comps.length; ci++) {
      var comp = lab.comps[ci];
      if (comp.area < w * h * 0.008) continue;
      var sc = 0, k;
      for (k = 0; k < comp.pixels.length; k++) {
        var p = comp.pixels[k], pxx = p % w, pyy = (p / w) | 0;
        if (rect && rect.w > 12 && rect.h > 12) {
          /* في وضع الجزء المحدّد: نحسب داخل المستطيل */
          if (pxx >= rect.x && pxx < rect.x + rect.w && pyy >= rect.y && pyy < rect.y + rect.h) sc++;
        } else if (pxx >= bx0 && pxx <= bx1 && pyy >= by) sc++;
      }
      if (sc > bestScore) { bestScore = sc; best = comp; }
    }
    if (!best) return null;
    var mask = new Uint8Array(n);
    for (var k2 = 0; k2 < best.pixels.length; k2++) mask[best.pixels[k2]] = 1;
    mask = fillHoles(mask, w, h);
    var count = 0;
    for (i = 0; i < n; i++) if (mask[i]) count++;
    return { mask: mask, count: count, medCb: medCb, medCr: medCr, medL: medL };
  }

  function analyzeSpots(work, box, regions, garmentIn) {
    var res = { id: 'spots', title: 'الملابس', state: 'unknown', confidence: 0.25, text: '', action: '', evidence: '', metrics: {} };
    if (!box) { res.text = 'لا يمكن فحص الملابس قبل تحديد وجهك.'; return res; }
    var g = garmentIn || buildGarmentMask(work, box || { x: work.w * 0.25, y: work.h * 0.30, w: work.w * 0.50, h: work.h * 0.60 });
    var n = work.w * work.h;
    if (!g || g.count < n * 0.02) {
      res.text = 'لم أتمكّن من تمييز ملابسك في هذه الصورة.';
    res.action = 'اجعل ملابسك واضحة داخل الكادر ثم أعد اللقطة.';
      res.action = 'وجّه الكاميرا إلى صدرك حتى تظهر ملابسك بوضوح.';
      return res;
    }
    var medCb = g.medCb, medCr = g.medCr, medL = g.medL;
    var dev = new Uint8Array(n), devCount = 0, y, x, i;
    for (y = 0; y < work.h; y++) {
      for (x = 0; x < work.w; x++) {
        i = y * work.w + x;
        if (!g.mask[i]) continue;
        var cb = 128 - 0.1687 * work.R[i] - 0.3313 * work.G[i] + 0.5 * work.B[i];
        var cr = 128 + 0.5 * work.R[i] - 0.4187 * work.G[i] - 0.0813 * work.B[i];
        var dC = Math.hypot(cb - medCb, cr - medCr), dL = Math.abs(work.luma[i] - medL);
        if (dC > 15 || dL > 28) { dev[i] = 1; devCount++; }
      }
    }
    var devRatio = devCount / g.count;
    res.metrics.deviationRatio = devRatio;
    res.metrics.garmentPixels = g.count;
    if (devRatio > 0.32) {
      res.state = 'attention'; res.confidence = 0.35;
      res.text = 'ملابسك عليها نقوش أو ألوان متفرقة، لذلك لا أستطيع تمييز البقعة عن التصميم.';
      res.action = 'وجّه الكاميرا إلى القماش من قرب ليظهر إن كانت هناك بقعة.';
      res.evidence = 'نسبة البكسلات المختلفة ' + Math.round(devRatio * 100) + ' بالمئة';
      return res;
    }
    var lab = labelComponents(dev, work.w, work.h);
    var best = null;
    for (var ci = 0; ci < lab.comps.length; ci++) {
      var comp = lab.comps[ci];
      if (!best || comp.area > best.area) best = comp;
    }
    var minArea = Math.max(80, g.count * 0.0025);
    if (!best || best.area < minArea) {
      res.state = 'ok'; res.confidence = 0.55;
      res.text = 'لا تظهر علامة لونية موضعية على ملابسك.';
      res.evidence = 'نسبة البكسلات المختلفة ' + Math.round(devRatio * 100) + ' بالمئة';
      return res;
    }
    var bb = bboxOf(work, best.pixels);
    var fill = best.area / Math.max(1, bb.w * bb.h);
    res.metrics.spotArea = best.area;
    res.metrics.spotFill = fill;
    if (fill < 0.28 || bb.w > g.count * 0 + work.w * 0.95 || bb.h > work.h * 0.95) {
      res.state = 'ok'; res.confidence = 0.45;
      res.text = 'لا تظهر بقعة موضعية واضحة على ملابسك.';
      res.evidence = 'تجمّعات صغيرة متفرقة بدل بقعة واحدة';
      return res;
    }
    var sx = 0, sy = 0, k;
    for (k = 0; k < best.pixels.length; k++) {
      sx += best.pixels[k] % work.w;
      sy += (best.pixels[k] / work.w) | 0;
    }
    var mx = sx / best.pixels.length, my = sy / best.pixels.length;
    /* النصف الأيسر من الصورة هو يمين المستخدم */
    var side = mx < (box.x + box.w / 2) ? 'يمينك' : 'يسارك';
    var rel = (my - (box.y + box.h * 1.08)) / Math.max(1, work.h - (box.y + box.h * 1.08));
    var vert = rel < 0.34 ? 'أعلى' : (rel > 0.66 ? 'أسفل' : 'منتصف');
    res.state = 'attention'; res.confidence = 0.45;
    res.text = 'توجد علامة لونية موضعية على ' + vert + ' ' + side + ' من صدرك.';
    res.action = 'انظر إلى تلك النقطة بعينك أو بلمسها لتتأكد.';
    res.evidence = 'مساحة العلامة ' + best.area + ' بكسل، ونسبة البكسلات المختلفة ' + Math.round(devRatio * 100) + ' بالمئة';
    return res;
  }

  /* ------------------------------------------------------------------ */
  /* 11) مؤلّف التقرير                                                   */
  /* ------------------------------------------------------------------ */
  function composeReport(results) {
    var all = results.filter(function (r) { return !!r; });
    var info = all.filter(function (r) { return r.kind === 'info' && r.text; });
    /* فحوص حساسة (الحجاب وتغطية الجسد): التحذير يُقال حتى بثقة منخفضة،
       و«سليم» لا يُقال كحقيقة إلا بثقة عالية — الخطأ في الاتجاه الثاني أخطر. */
    var SENSITIVE = { headcover: 1, coverage: 1 };
    var known = all.filter(function (r) {
      if (r.kind === 'info' || r.state === 'unknown') return false;
      if (SENSITIVE[r.id] && r.state === 'attention') return r.confidence >= 0.25;
      return r.confidence >= 0.4;
    });
    var unverified = known.filter(function (r) { return SENSITIVE[r.id] && r.state === 'ok' && r.confidence < 0.7; });
    var attention = known.filter(function (r) { return r.state === 'attention'; });
    attention.sort(function (a, b) { return b.confidence - a.confidence; });
    var okList = known.filter(function (r) { return r.state === 'ok' && unverified.indexOf(r) < 0; });
    var unverifiedLine = unverified.length
      ? ('لم أستطع التأكد تماماً من: ' + unverified.map(function (r) { return r.title; }).join(' و') + '. تحقّق منها بلمس يدك.')
      : '';
    var items = attention.slice(0, 4);
    var shortParts = [], detailParts = [];

    if (info.length) {
      shortParts.push(info.map(function (r) { return r.text; }).join(' '));
    }
    if (!known.length) {
      if (!info.length) shortParts.push('لم أستطع الحكم على مظهرك في هذه الصورة.');
      var hints = [];
      all.forEach(function (r) { if (r && r.action && hints.indexOf(r.action) < 0) hints.push(r.action); });
      if (hints.length) shortParts.push(hints[0]);
      all.forEach(function (r) {
        if (r && r.text) detailParts.push(r.title + ': ' + r.text + (r.action ? ' — الإجراء: ' + r.action : ''));
      });
      return { short: shortParts.join(' '), detail: detailParts.join('\n'), items: [], known: 0, attention: 0, info: info.length };
    }
    if (items.length) {
      shortParts.push('انتهى الفحص. ' + (items.length === 1 ? 'هناك أمر واحد يحتاج انتباهك.' : 'هناك ' + arNum(items.length) + ' أمور تحتاج انتباهك.'));
      items.forEach(function (r) {
        shortParts.push(r.text + (r.action ? ' ' + r.action : ''));
      });
      /* سطر صريح: ما الذي يجب أن يرتّبه المستخدم */
      var acts = [];
      items.forEach(function (r) { if (r.action && acts.indexOf(r.action) < 0) acts.push(r.action); });
      if (acts.length) {
        shortParts.push('ما يجب أن ترتّبه الآن: ' + acts.map(function (a, i) { return arNum(i + 1) + ') ' + a; }).join(' '));
      }
      if (okList.length) {
        shortParts.push('تفاصيل مظهرك: ' + okList.slice(0, 4).map(function (r) { return r.text; }).join(' '));
      }
      if (unverifiedLine) shortParts.push(unverifiedLine);
    } else {
      shortParts.push(unverified.length ? 'انتهى الفحص. لم أجد شيئاً واضحاً يحتاج انتباهك.' : 'انتهى الفحص. لم أجد شيئاً يحتاج انتباهك.');
      if (okList.length) {
        shortParts.push('تفاصيل مظهرك: ' + okList.slice(0, 5).map(function (r) { return r.text; }).join(' '));
      }
      if (unverifiedLine) shortParts.push(unverifiedLine);
    }
    all.forEach(function (r) {
      var line = r.title + ': ' + (r.text || 'لا توجد نتيجة');
      if (r.action) line += ' — الإجراء: ' + r.action;
      if (r.evidence) line += ' (' + r.evidence + ')';
      detailParts.push(line);
    });
    return { short: shortParts.join(' '), detail: detailParts.join('\n'), items: items, known: known.length, attention: attention.length, info: info.length };
  }

  /* ------------------------------------------------------------------ */
  /* 12) الفحص الكامل                                                    */
  /* ------------------------------------------------------------------ */
  function makeColorResult(id, title, name) {
    return {
      id: id, title: title, state: 'ok', kind: 'info', confidence: 0.4,
      text: title + ': ' + name + '.', action: '', evidence: ''
    };
  }

  function runInspection(options) {
    options = options || {};
    var source = options.source;
    var mode = options.mode || 'face';
    var profile = options.profile || null;
    var work = options.work || buildWorkingImage(source, options.maxDim || 480, options.workCanvas);
    var needFace = (mode === 'face' || mode === 'full');
    /* نبحث عن الوجه في كل الأوضاع (حتى السفلي) لأنه يثبّت المناطق النسبية */
    var nativePromise = options.skipNative ? Promise.resolve(null) : detectFaceBoxNative(source);

    return nativePromise.then(function (nat) {
      var box = null, srcUsed = 'none';
      if (nat) {
        box = {
          x: nat.nx * work.w, y: nat.ny * work.h,
          w: nat.nw * work.w, h: nat.nh * work.h,
          conf: nat.conf, src: 'native'
        };
        srcUsed = 'native';
      } else {
        box = detectFaceBoxBySkin(work);
        if (box) srcUsed = 'skin';
      }
      var faceRegions = buildRegions(box, work.w, work.h);
      var shot = buildShotRegions(work, box, mode);
      var skinMask = buildSkinMask(work);
      var results = [];
      var garment = null;
      var pseudoBox = box || { x: work.w * 0.25, y: work.h * 0.30, w: work.w * 0.50, h: work.h * 0.60 };
      /* امتداد الشخص داخل الكادر: صادقته في الحذاء والتغطية */
      var extent = box ? detectPersonExtent(work, box) : null;
      if (mode === 'back') {
        /* الظهر: لا وجه في الكادر — نحدّد الجسم من الصورة كاملة */
        extent = detectPersonExtent(work, { x: work.w * 0.30, y: 0, w: work.w * 0.40, h: work.h * 0.40 });
      }

      if (mode === 'face') {
        results.push(checkFraming(work, box, faceRegions));
        results.push(checkLighting(work, box));
        if (box) {
          results.push(analyzeHair(work, box, faceRegions, skinMask, options));
          results.push(analyzeGlasses(work, box, faceRegions));
          results.push(analyzeBeard(work, box, faceRegions));
          results.push(analyzeHeadCover(work, box, faceRegions, profile));
        } else {
          results.push({ id: 'hair', title: 'الشعر', state: 'unknown', confidence: 0.1, text: 'لا يمكن فحص الشعر قبل تحديد وجهك.', action: '' });
          results.push({ id: 'glasses', title: 'النظارة', state: 'unknown', confidence: 0.1, text: 'لا يمكن فحص النظارة قبل تحديد وجهك.', action: '' });
          results.push({ id: 'beard', title: 'اللحية', state: 'unknown', confidence: 0.1, text: 'لا يمكن فحص اللحية قبل تحديد وجهك.', action: '' });
        }
      }

      if (mode === 'upper' || mode === 'lower' || mode === 'full') {
        /* الدقة: كل قياسات الملابس تتبع ظلّ الشخص نفسه، لا نطاقاً ثابتاً في الإطار.
           (وإلا خُطط لونُ الخلفية مع لون الملابس) */
        var gBox = pseudoBox;
        if (extent && extent.area > work.w * work.h * 0.02) {
          var bH = Math.max(12, extent.bottom - extent.top);
          var bW = Math.max(12, extent.right - extent.left);
          gBox = { x: extent.left, y: extent.top, w: bW, h: Math.max(8, Math.round(bH * 0.55)) };
          shot.chest = { x: extent.left, y: extent.top + Math.round(bH * 0.18), w: bW, h: Math.max(8, Math.round(bH * 0.30)) };
          var shoeBand = Math.max(4, Math.round(bH * 0.05));
          shot.legs = {
            x: extent.left, y: extent.top + Math.round(bH * 0.50), w: bW,
            h: Math.max(8, Math.round(bH * 0.50) - shoeBand)
          };
          shot.torso = { x: extent.left, y: extent.top, w: bW, h: bH };
        }
        garment = buildGarmentMask(work, gBox);
        var chestG = null, legsG = null;
        if (mode === 'upper' || mode === 'full') {
          chestG = buildGarmentMask(work, gBox, shot.chest);
          var topCol = chestG ? dominantColor(work, chestG.mask, shot.chest || shot.torso) : null;
          if (topCol) results.push(makeColorResult('topColor', 'الجزء العلوي', topCol.name));
          results.push(analyzeSpots(work, pseudoBox, shot, chestG || garment));
          results.push(analyzeTuck(work, shot));
          results.push(analyzeBodyCoverage(work, box, shot, chestG || garment));
          results.push(analyzeWrinkles(work, shot, chestG || garment));
        }
        if (mode === 'lower' || mode === 'full') {
          legsG = buildGarmentMask(work, gBox, shot.legs);
          var legCol = legsG ? dominantColor(work, legsG.mask, shot.legs || shot.torso) : null;
          if (legCol) results.push(makeColorResult('bottomColor', 'الجزء السفلي', legCol.name));
          var shoeRes = analyzeShoes(work, shot, extent);
          if (shoeRes.state === 'ok' && shoeRes.metrics && shoeRes.metrics.leftColor) {
            results.push(makeColorResult('shoeColor', 'الحذاء', shoeRes.metrics.leftColor));
          }
          results.push(shoeRes);
        }
        if (mode === 'full') {
          var outfit = analyzeOutfitCombination({
            top: results.filter(function (r) { return r.id === 'topColor'; }).map(function (r) { return r.text; }).map(function (t) { return t.replace('الجزء العلوي: ', '').replace('.', ''); })[0],
            bottom: results.filter(function (r) { return r.id === 'bottomColor'; }).map(function (r) { return r.text; }).map(function (t) { return t.replace('الجزء السفلي: ', '').replace('.', ''); })[0],
            shoes: shoeRes && shoeRes.metrics ? shoeRes.metrics.leftColor : null
          });
          if (outfit && outfit.text) results.push(outfit);
        }
      }

      if (mode === 'back') {
        var backG = buildGarmentMask(work, pseudoBox, shot.chest);
        var backCol = backG ? dominantColor(work, backG.mask, shot.chest || shot.torso) : null;
        if (backCol) results.push(makeColorResult('backTop', 'ظهر القميص', backCol.name));
        var backWr = analyzeWrinkles(work, shot, backG);
        results.push(backWr);
        if (extent && extent.bottom < work.h - 6) {
          var backShoes = analyzeShoes(work, shot, extent);
          if (backShoes.state === 'ok' && backShoes.metrics && backShoes.metrics.leftColor) {
            results.push(makeColorResult('backShoes', 'الحذاء من الخلف', backShoes.metrics.leftColor));
          }
        }
        results.push({
          id: 'backView', title: 'منظر الظهر', state: 'ok', kind: 'info', confidence: 0.4,
          text: 'أخذت لقطة من الخلف كما طلبت.', action: '', evidence: ''
        });
      }

      var report = composeReport(results);
      return {
        work: work, box: box, regions: faceRegions, shot: shot,
        garment: garment, results: results, report: report, faceSource: srcUsed, mode: mode
      };
    });
  }

  /* ------------------------------------------------------------------ */
  /* 13) أسماء الألوان (مصدر واحد للتطبيق والاختبار)                     */
  /* ------------------------------------------------------------------ */
  function classifyColorName(r, g, b) {
    var max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    var v = max / 255, s = max === 0 ? 0 : d / max;
    if (v < 0.16) return 'أسود';
    if (s < 0.14) return v > 0.82 ? 'أبيض' : (v > 0.52 ? 'رمادي فاتح' : 'رمادي غامق');
    var h;
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h = (h * 60 + 360) % 360;
    if (h < 12 || h >= 345) return v < 0.45 ? 'عنابي' : 'أحمر';
    if (h < 32) return (v < 0.58 && s < 0.72) ? 'بني' : 'برتقالي';
    if (h < 55) return (v > 0.75 && s < 0.45) ? 'بيج' : 'أصفر';
    if (h < 85) return v < 0.52 ? 'زيتوني' : 'أخضر فاتح';
    if (h < 160) return v < 0.45 ? 'أخضر غامق' : 'أخضر';
    if (h < 195) return 'تركوازي';
    if (h < 250) return v < 0.45 ? 'كحلي' : (v > 0.78 ? 'سماوي' : 'أزرق');
    if (h < 290) return 'بنفسجي';
    return 'وردي';
  }

  /* اللون الغالب داخل مستطيل أو قناع */
  function dominantColor(work, mask, rect) {
    var buckets = {}, counts = {}, total = 0;
    var y, x, i;
    for (y = rect.y; y < rect.y + rect.h; y++) {
      for (x = rect.x; x < rect.x + rect.w; x++) {
        i = y * work.w + x;
        if (mask && !mask[i]) continue;
        if (work.luma[i] > 250 || work.luma[i] < 10) continue;
        var key = classifyColorName(work.R[i], work.G[i], work.B[i]);
        if (!buckets[key]) { buckets[key] = { r: 0, g: 0, b: 0, n: 0 }; counts[key] = 0; }
        var bk = buckets[key];
        bk.r += work.R[i]; bk.g += work.G[i]; bk.b += work.B[i]; bk.n++;
        counts[key]++; total++;
      }
    }
    if (total < 40) return null;
    var best = null, bestN = 0;
    for (var k in counts) if (counts[k] > bestN) { bestN = counts[k]; best = k; }
    var b = buckets[best];
    return {
      name: best,
      ratio: bestN / total,
      rgb: { r: Math.round(b.r / b.n), g: Math.round(b.g / b.n), b: Math.round(b.b / b.n) }
    };
  }

  /* ------------------------------------------------------------------ */
  /* 14) مناطق اللقطات (وجه / علوي / سفلي / كامل)                         */
  /* ------------------------------------------------------------------ */
  function buildShotRegions(work, box, mode) {
    var w = work.w, h = work.h;
    var r = {};
    if (mode === 'upper') {
      r.torso = clipRect(w * 0.06, h * 0.20, w * 0.88, h * 0.80, w, h);
      r.chest = clipRect(w * 0.16, h * 0.22, w * 0.68, h * 0.30, w, h);
      r.waist = clipRect(w * 0.10, h * 0.55, w * 0.80, h * 0.30, w, h);
      r.shoulders = clipRect(w * 0.02, h * 0.18, w * 0.96, h * 0.22, w, h);
    } else if (mode === 'lower') {
      r.legs = clipRect(w * 0.06, h * 0.30, w * 0.88, h * 0.52, w, h);
      r.feet = clipRect(0, h * 0.80, w, h * 0.20, w, h);
    } else if (mode === 'full') {
      r.torso = clipRect(w * 0.18, h * 0.16, w * 0.64, h * 0.34, w, h);
      r.chest = clipRect(w * 0.22, h * 0.17, w * 0.56, h * 0.16, w, h);
      r.waist = clipRect(w * 0.18, h * 0.44, w * 0.64, h * 0.14, w, h);
      r.legs = clipRect(w * 0.20, h * 0.52, w * 0.60, h * 0.32, w, h);
      r.feet = clipRect(w * 0.04, h * 0.82, w * 0.92, h * 0.18, w, h);
    } else if (mode === 'back') {
      r.torso = clipRect(w * 0.10, h * 0.10, w * 0.80, h * 0.85, w, h);
      r.chest = clipRect(w * 0.14, h * 0.12, w * 0.72, h * 0.42, w, h);
      r.legs = clipRect(w * 0.14, h * 0.55, w * 0.72, h * 0.43, w, h);
      r.feet = clipRect(w * 0.04, h * 0.84, w * 0.92, h * 0.16, w, h);
    } else {
      r.torso = clipRect(w * 0.06, h * 0.45, w * 0.88, h * 0.55, w, h);
      r.feet = clipRect(0, h * 0.85, w, h * 0.15, w, h);
    }
    if (box) {
      /* إن ظهر الوجه في اللقطة، نثبّتInicio النسب على أساسه */
      var chin = box.y + box.h * 1.05;
      if ((mode === 'upper' || mode === 'full') && chin > 0) {
        r.chest = clipRect(box.x - box.w * 0.4, chin, box.w * 1.8, box.h * 0.95, w, h);
        if (mode === 'upper') {
          /* منطقة الخصر: نسبةً للإطار (أدقّ من تقدير الوجه في الجلسات القريبة) */
          r.waist = clipRect(w * 0.10, h * 0.55, w * 0.80, h * 0.30, w, h);
        }
      }
    }
    return r;
  }

  /* ------------------------------------------------------------------ */
  /* 15) وحدة اللحية والذقن                                            */
  /* ------------------------------------------------------------------ */
  function analyzeBeard(work, box, regions) {
    var res = { id: 'beard', title: 'اللحية', state: 'unknown', confidence: 0.25, text: '', action: '', evidence: '', metrics: {} };
    var jaw = regions ? regions.jaw : null;
    var cheek = regions ? regions.cheek : null;
    if (!box || !jaw || !cheek) { res.text = 'لا يمكن فحص اللحية في هذه اللقطة.'; return res; }
    var cheekSt = regionLuma(work, cheek);
    if (!cheekSt) { res.text = 'لا يمكن تحديد لون البشرة في هذه اللقطة.'; return res; }
    var skinL = cheekSt.median;
    var n = work.w * work.h;
    /* حدّ الوجه (قطع ناقص): اللحية داخله فقط، فلا يقع الشعر النازل على الجانبين */
    var ecx = box.x + box.w / 2, ecy = box.y + box.h * 0.46;
    var erx = box.w * 0.44, ery = box.h * 0.54;
    function insideFace(px, py) {
      var a1 = (px - ecx) / erx, a2 = (py - ecy) / ery;
      return a1 * a1 + a2 * a2 <= 1.0;
    }
    var beard = new Uint8Array(n), cnt = 0, y, x, i;
    for (y = jaw.y; y < jaw.y + jaw.h; y++) {
      for (x = jaw.x; x < jaw.x + jaw.w; x++) {
        if (!insideFace(x, y)) continue;
        i = y * work.w + x;
        if (work.luma[i] < skinL * 0.80 && work.luma[i] > 12) { beard[i] = 1; cnt++; }
      }
    }
    var area = jaw.w * jaw.h;
    var ratio = area ? cnt / area : 0;
    res.metrics.beardRatio = ratio;
    if (ratio < 0.07) {
      res.state = 'ok'; res.confidence = 0.4;
      res.text = 'لا تظهر لحية على ذقنك.';
      res.evidence = 'نسبة المنطقة ' + Math.round(ratio * 100) + ' بالمئة';
      return res;
    }
    /* خشونة حدّ اللحية: نصف القطر في 32 قوس حول مركز الذقن */
    var cx = box.x + box.w / 2, cy = box.y + box.h * 0.92;
    var radii = [], k;
    for (k = 0; k < 32; k++) {
      var ang = Math.PI * (k / 31) + Math.PI;   /* القوس السفلي حول الذقن */
      var found = 0, t;
      for (t = 2; t < box.h * 1.3; t += 2) {
        var qx = Math.round(cx + Math.cos(ang) * t), qy = Math.round(cy + Math.sin(ang) * t);
        if (qx < 0 || qy < 0 || qx >= work.w || qy >= work.h) break;
        if (beard[qy * work.w + qx]) found = t;
      }
      radii.push(found);
    }
    var meanR = meanOf(radii), rough = meanR ? stdevOf(radii) / meanR : 0;
    res.metrics.roughness = rough;
    /* شعرات متفرقة على الخد: بكسلات داكنة معزولة فقط (الشعر النازل كتلة كبيرة) */
    var strays = 0, cheekArea = cheek.w * cheek.h;
    for (y = cheek.y; y < cheek.y + cheek.h; y++) {
      for (x = cheek.x; x < cheek.x + cheek.w; x++) {
        if (!insideFace(x, y)) continue;
        i = y * work.w + x;
        if (!(work.luma[i] < skinL * 0.80 && work.luma[i] > 12)) continue;
        var dark = 0, dy, dx;
        for (dy = -1; dy <= 1; dy++) {
          for (dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            var jx = x + dx, jy = y + dy;
            if (jx < 0 || jy < 0 || jx >= work.w || jy >= work.h) continue;
            if (work.luma[jy * work.w + jx] < skinL * 0.80 && work.luma[jy * work.w + jx] > 12) dark++;
          }
        }
        if (dark <= 1) strays++;
      }
    }
    res.metrics.strayRatio = cheekArea ? strays / cheekArea : 0;
    /* رغوة أو كريم (داخل حدّ الوجه فقط) */
    var foam = 0;
    for (y = jaw.y; y < jaw.y + jaw.h; y++) {
      for (x = jaw.x; x < jaw.x + jaw.w; x++) {
        if (!insideFace(x, y)) continue;
        i = y * work.w + x;
        var mx = Math.max(work.R[i], work.G[i], work.B[i]), mn = Math.min(work.R[i], work.G[i], work.B[i]);
        if (work.luma[i] > 195 && (mx === 0 || (mx - mn) / mx < 0.20)) foam++;
      }
    }
    res.metrics.foamRatio = area ? foam / area : 0;

    var msgs = [], acts = [], conf = 0.45;
    if (rough > 0.15) {
      /* النصف الأيسر من الصورة هو يمين المستخدم */
      msgs.push('حدّ لحيتك غير مستوٍ عند ' + (radii.indexOf(Math.max.apply(null, radii)) % 2 ? 'يسارك' : 'يمينك') + '.');
      acts.push('احلق ذقنك ونظّفه بعد الحلاقة.');
      conf = 0.4;
    }
    if (res.metrics.strayRatio > 0.012) {
      msgs.push('توجد شعرات متفرقة على خدك.');
      acts.push('انظر إلى خدك بعينك أو بلمسه.');
    }
    if (res.metrics.foamRatio > 0.006) {
      msgs.push('يوجد أثر أبيض يشبه الرغوة أو كريم على ذقنك.');
      acts.push('تأكّد من إزالة الأثر قبل الخروج.');
    }
    if (!msgs.length) {
      res.state = 'ok'; res.text = 'لحيتك مرتبة إلى حد ما.';
      res.confidence = 0.45;
    } else {
      res.state = 'attention';
      res.text = msgs.join(' ');
      res.action = acts.join(' ');
      res.confidence = conf;
    }
    res.evidence = 'نسبة المنطقة ' + Math.round(ratio * 100) + ' بالمئة';
    return res;
  }

  /* ------------------------------------------------------------------ */
  /* 16) وحدة غطاء الرأس (الحجاب) — تُفعَّل من الملف الشخصي فقط          */
  /* ------------------------------------------------------------------ */
  /* وسيط لون منطقة (RGB) */
  function medianRgb(work, rect) {
    if (!rect || rect.w < 4 || rect.h < 4) return null;
    var rs = [], gs = [], bs = [], y, x, i;
    for (y = rect.y; y < rect.y + rect.h; y++) {
      for (x = rect.x; x < rect.x + rect.w; x++) {
        i = y * work.w + x;
        if (work.luma[i] > 252 || work.luma[i] < 4) continue;
        rs.push(work.R[i]); gs.push(work.G[i]); bs.push(work.B[i]);
      }
    }
    if (rs.length < 20) return null;
    return { r: medianOf(rs), g: medianOf(gs), b: medianOf(bs) };
  }
  function colorDist(a, b) {
    if (!a || !b) return 999;
    return Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b);
  }

  function analyzeHeadCover(work, box, regions, profile) {
    var res = { id: 'headcover', title: 'غطاء الرأس', state: 'unknown', confidence: 0.2, text: '', action: '', evidence: '', metrics: {} };
    if (!profile || !profile.wearsHeadCover) { res.state = 'unknown'; res.confidence = 0; res.text = ''; return res; }
    if (!box) { res.text = 'لا يمكن فحص غطاء الرأس في هذه اللقطة.'; return res; }
    var w = work.w, h = work.h, n = w * h;
    var faceCore = clipRect(box.x + box.w * 0.25, box.y + box.h * 0.35, box.w * 0.50, box.h * 0.40, w, h);
    var skinRgb = medianRgb(work, faceCore);
    var skinL = skinRgb ? 0.299 * skinRgb.r + 0.587 * skinRgb.g + 0.114 * skinRgb.b : 140;
    /* الجبهة: المنطقة فوق الوجه مباشرة */
    /* الجبهة: فوق صندوق الوجه (خط الشعر) لا داخله */
    var fore = clipRect(box.x + box.w * 0.20, box.y - box.h * 0.30, box.w * 0.60, box.h * 0.26, w, h);
    var foreRgb = medianRgb(work, fore);
    /* حلقّة حول الرأس: أين يظهر غطاء الرأس */
    var ringL = clipRect(box.x - box.w * 0.55, box.y - box.h * 0.45, box.w * 0.45, box.h * 0.60, w, h);
    var ringR = clipRect(box.x + box.w * 1.10, box.y - box.h * 0.45, box.w * 0.45, box.h * 0.60, w, h);
    var ringT = clipRect(box.x + box.w * 0.15, box.y - box.h * 0.55, box.w * 0.70, box.h * 0.40, w, h);
    var coverRgb = medianRgb(work, ringL) || medianRgb(work, ringR) || medianRgb(work, ringT);

    var msgs = [], acts = [], conf = 0.32;
    /* 1) الجبهة مكشوفة؟ نقارن لون الجبهة بلون البشرة لا بالإضاءة فقط */
    if (profile.coverForehead && foreRgb && skinRgb) {
      var dForeSkin = colorDist(foreRgb, skinRgb);
      var dForeCover = coverRgb ? colorDist(foreRgb, coverRgb) : 999;
      res.metrics.foreheadVsSkin = Math.round(dForeSkin);
      res.metrics.foreheadVsCover = Math.round(dForeCover);
      if (dForeSkin < 32 && dForeCover > 34) {
        msgs.push('جزء من جبهتك يبدو غير مغطى.');
        acts.push('غطِّ جبهتك بغطاء الرأس.');
      } else if (dForeSkin < 32 && dForeCover <= 34) {
        /* لون الجبهة = لون الغطاء: مغطاة */
      }
    }
    /* 2) خيوط شعر بارزة خارج الغطاء: خطوط داكنة رفيعة على خلفية أفتح */
    var strandL = 0, strandR = 0, areaL = 0, areaR = 0, y, x, i;
    function countStrands(rect) {
      var cnt = 0, area = 0;
      if (!rect || rect.w < 6 || rect.h < 6) return { cnt: 0, area: 0 };
      for (y = rect.y; y < rect.y + rect.h; y++) {
        for (x = rect.x; x < rect.x + rect.w; x++) {
          i = y * work.w + x;
          area++;
          if (work.luma[i] > skinL * 0.55) continue;
          var nb = 0, tot = 0, dy, dx;
          for (dy = -2; dy <= 2; dy++) {
            for (dx = -2; dx <= 2; dx++) {
              var q = (y + dy) * w + (x + dx);
              if (q < 0 || q >= n) continue;
              tot++; if (work.luma[q] > work.luma[i] + 22) nb++;
            }
          }
          if (tot > 0 && nb / tot > 0.42) cnt++;
        }
      }
      return { cnt: cnt, area: area };
    }
    var sL = countStrands(ringL), sR = countStrands(ringR), sT = countStrands(ringT);
    strandL = sL.cnt; strandR = sR.cnt;
    areaL = sL.area + sT.area * 0.5; areaR = sR.area + sT.area * 0.5;
    var strandRatio = ((strandL + strandR) / Math.max(1, areaL + areaR));
    res.metrics.strandRatio = strandRatio;
    res.metrics.strandLeft = strandL;
    res.metrics.strandRight = strandR;
    if (strandRatio > 0.006) {
      var side = strandR > strandL ? 'يسارك' : 'يمينك';
      msgs.push('قد يظهر جزء من شعرك خارج غطاء الرأس عند ' + side + '.');
      acts.push('اسحب غطاء الرأس على الشعر ثم أعد الفحص.');
      conf = 0.3;
    }
    /* 2-ب) خط الشعر داخل صندوق الوجه: أكثر موضع يظهر فيه الشعر تحت الحجاب.
       الشعر الداكن أمام الجبهة الفاتحة يُرى بالسطوع ولو كان الحجاب بنفس لونه. */
    var fem = (profile.headCover === 'hijab');
    function darkFrac(r) {
      if (!r || r.w < 4 || r.h < 3) return 0;
      var c = 0, t = 0, yy, xx;
      for (yy = r.y; yy < r.y + r.h; yy++) for (xx = r.x; xx < r.x + r.w; xx++) {
        t++; if (work.luma[yy * w + xx] < skinL * 0.60) c++;
      }
      return t ? c / t : 0;
    }
    var hlMidX = box.x + box.w / 2;
    var hlL = darkFrac(clipRect(box.x + box.w * 0.25, box.y + box.h * 0.09, hlMidX - (box.x + box.w * 0.25), box.h * 0.08, w, h));
    var hlR = darkFrac(clipRect(hlMidX, box.y + box.h * 0.09, box.x + box.w * 0.75 - hlMidX, box.h * 0.08, w, h));
    res.metrics.hairlineLeft = hlL; res.metrics.hairlineRight = hlR;
    if (hlL > 0.08 || hlR > 0.08) {
      /* النصف الأيسر من الصورة هو يمين المستخدم */
      var hside = (hlL > 0.08 && hlR > 0.08) ? 'الجبهة' : (hlL > hlR ? 'الجبهة من جهة يمينك' : 'الجبهة من جهة يسارك');
      msgs.push('قد يظهر شعر عند حافة ' + hside + '.');
      acts.push(fem ? 'المسي حافة الحجاب هناك واسحبيه ليغطي الشعر.' : 'المس حافة غطاء الرأس هناك واسحبه ليغطي الشعر.');
      conf = Math.min(conf, 0.3);
    }
    /* 3) عدم التماثل: نقارن إضاءة الغطاء على الجهتين */
    var lSt = regionLuma(work, ringL), rSt = regionLuma(work, ringR);
    var asym = 0;
    if (lSt && rSt) {
      asym = Math.abs(lSt.median - rSt.median) / Math.max(1, Math.max(lSt.median, rSt.median));
      res.metrics.asymmetry = asym;
      if (asym > 0.30) {
        msgs.push('غطاء رأسك يبدو غير متساوٍ بين الجهتين.');
        acts.push('عدّل غطاء الرأس ليصبح متساوياً على جهتي رأسك.');
        conf = Math.min(conf, 0.3);
      }
    }
    if (!msgs.length) {
      res.state = 'ok'; res.confidence = 0.4;
      /* لا نجزم أبداً: الفحص البصري وحده لا يضمن أن الشعر مغطى */
      res.text = 'لم ألحظ شعراً ظاهراً من غطاء رأسك في هذه اللقطة، لكن لا أستطيع الجزم.';
      res.action = fem ? 'المسي حافة الحجاب عند الجبهة والصدغين للتأكد.' : 'المس حافة غطاء الرأس للتأكد.';
    } else {
      res.state = 'attention';
      res.text = msgs.join(' ');
      res.action = acts.join(' ');
      res.confidence = conf;
    }
    res.evidence = 'خيوط بارزة ' + Math.round(strandRatio * 1000) + ' من ألف';
    return res;
  }

  /* ------------------------------------------------------------------ */
  /* 17) وحدة تغطية الجسم (أجزاء ظاهرة غير مغطاة)                        */
  /* ------------------------------------------------------------------ */
  function analyzeBodyCoverage(work, box, regions, garment) {
    var res = { id: 'coverage', title: 'تغطية الجسم', state: 'unknown', confidence: 0.25, text: '', action: '', evidence: '', metrics: {} };
    var r = regions ? regions.torso : null;
    if (!r || r.w < 20 || r.h < 20) { res.text = 'منطقة الجذع غير داخل الإطار.'; return res; }
    var skin = buildSkinMask(work);
    var n = work.w * work.h, y, x, i;
    var minY = 0;
    if (box) minY = box.y + box.h * 1.12;
    else minY = r.y + r.h * 0.18;
    var exposed = 0, tot = 0;
    var expoPix = [];
    var yLimit = r.y + r.h * 0.80;   /* لا نحصي الحذاء ولا الأرض */
    for (y = Math.max(r.y, Math.round(minY)); y < Math.min(r.y + r.h, yLimit); y++) {
      for (x = r.x; x < r.x + r.w; x++) {
        i = y * work.w + x;
        if (garment && garment.mask[i]) continue;
        tot++;
        if (!skin[i]) continue;
        exposed++;
        expoPix.push(i);
      }
    }
    /* أكبر كتلة مكشوفة (قد تكون ذراعاً أو رقبة) لتحديد موضعها بدقة */
    var cxExpo = 0, cyExpo = 0, bigArea = 0;
    if (expoPix.length) {
      var emask = new Uint8Array(n);
      expoPix.forEach(function (idx) { emask[idx] = 1; });
      var elab = labelComponents(emask, work.w, work.h);
      var big = null;
      elab.comps.forEach(function (c) { if (!big || c.area > big.area) big = c; });
      if (big) {
        bigArea = big.area;
        var sx = 0, sy = 0;
        big.pixels.forEach(function (idx) { sx += idx % work.w; sy += (idx / work.w) | 0; });
        cxExpo = sx / big.pixels.length;
        cyExpo = sy / big.pixels.length;
      }
    }
    var ratio = tot ? exposed / tot : 0;
    res.metrics.exposedRatio = ratio;
    res.metrics.exposedPixels = exposed;
    if (tot < 400) { res.text = 'منطقة الجذع غير واضحة في هذه الصورة.'; return res; }
    if (ratio < 0.035) {
      res.state = 'ok'; res.confidence = 0.4;
      res.text = 'لا يظهر جزء من جلدك خارج الملابس في هذه اللقطة.';
      res.evidence = 'نسبة الظاهر ' + Math.round(ratio * 100) + ' بالمئة';
      return res;
    }
    /* النصف الأيسر من الصورة هو يمين المستخدم */
    var side = cxExpo >= (r.x + r.w / 2) ? 'يسارك' : 'يمينك';
    var relV = (cyExpo - r.y) / Math.max(1, r.h);
    var vert = relV < 0.33 ? 'أعلى' : (relV > 0.66 ? 'أسفل' : 'منتصف');
    res.state = 'attention'; res.confidence = 0.35;
    res.text = 'يظهر جزء من جسمك غير مغطى عند ' + vert + ' ' + side + '.';
    res.action = 'تحقّق من تغطية هذا الموضع قبل الخروج.';
    res.metrics.largestPatch = bigArea;
    res.evidence = 'نسبة الظاهر ' + Math.round(ratio * 100) + ' بالمئة';
    return res;
  }

  /* ------------------------------------------------------------------ */
  /* 18) وحدة القميص: مهندم أم منسدل                                     */
  /* ------------------------------------------------------------------ */
  function analyzeTuck(work, regions) {
    var res = { id: 'tuck', title: 'القميص', state: 'unknown', confidence: 0.25, text: '', action: '', evidence: '', metrics: {} };
    var waist = regions ? regions.waist : null;
    if (!waist || waist.w < 30 || waist.h < 40) { res.text = 'منطقة الخصر غير داخل الإطار.'; res.action = 'صوّر حتى يظهر خصرك وبطنك داخل الكادر.'; return res; }
    /* متوسط لون كل صف في منطقة الخصر */
    var rows = [], y, x, i;
    for (y = waist.y; y < waist.y + waist.h; y++) {
      var sr = 0, sg = 0, sb = 0, c = 0;
      for (x = waist.x; x < waist.x + waist.w; x++) {
        i = y * work.w + x;
        if (work.luma[i] > 250 || work.luma[i] < 10) continue;
        sr += work.R[i]; sg += work.G[i]; sb += work.B[i]; c++;
      }
      if (c > 10) rows.push({ y: y, r: sr / c, g: sg / c, b: sb / c, n: c });
    }
    if (rows.length < 8) { res.text = 'منطقة الخصر غير واضحة.'; return res; }
    /* صف التغيّر الأقصى (حافة أفقية = خط الخصر أو طرف القميص) */
    var bestIdx = 0, bestJump = 0, k;
    for (k = 2; k < rows.length - 2; k++) {
      var d = Math.hypot(rows[k].r - rows[k - 1].r, rows[k].g - rows[k - 1].g, rows[k].b - rows[k - 1].b);
      if (d > bestJump) { bestJump = d; bestIdx = k; }
    }
    var topBand = rows.slice(Math.max(0, bestIdx - 3), Math.max(1, bestIdx - 1));
    var botBand = rows.slice(Math.min(rows.length - 1, bestIdx + 1), Math.min(rows.length, bestIdx + 3));
    if (!topBand.length || !botBand.length) { res.text = 'لم أتمكّن من تحديد خط الخصر.'; return res; }
    var ar = meanOf(topBand.map(function (o) { return o.r; })), ag = meanOf(topBand.map(function (o) { return o.g; })), ab = meanOf(topBand.map(function (o) { return o.b; }));
    var br = meanOf(botBand.map(function (o) { return o.r; })), bg = meanOf(botBand.map(function (o) { return o.g; })), bb = meanOf(botBand.map(function (o) { return o.b; }));
    var dCol = Math.hypot(ar - br, ag - bg, ab - bb);
    res.metrics.colorJump = dCol;
    res.metrics.edgeRow = rows[bestIdx].y;
    /* موضع خط الخصر داخل النطاق: في أعلاه = مهندم، في أسفله = منسدل */
    var relPos = (rows[bestIdx].y - rows[0].y) / Math.max(1, (rows[rows.length - 1].y - rows[0].y));
    res.metrics.edgeRelPos = relPos;
    if (dCol < 16) {
      /* النطاق بلون واحد: القميص يغطي الخصر ⇒ منسدل */
      res.state = 'attention'; res.confidence = 0.32;
      res.text = 'يبدو أن قميصك منسدل فوق البنطال وليس مهندماً.';
      res.action = 'هندم قميصك داخل البنطال إن كان هذا هو ما تريد.';
    } else if (relPos > 0.78) {
      /* طرف القميص منخفض جداً في النطاق ⇒ منسدل */
      res.state = 'attention'; res.confidence = 0.35;
      res.text = 'يبدو أن قميصك منسدل فوق البنطال وليس مهندماً.';
      res.action = 'هندم قميصك داخل البنطال إن كان هذا هو ما تريد.';
    } else {
      res.state = 'ok'; res.confidence = 0.4;
      res.text = 'يبدو أن قميصك مهندم داخل البنطال.';
    }
    res.evidence = 'فرق اللون عند خط الخصر ' + Math.round(dCol);
    return res;
  }

  /* ------------------------------------------------------------------ */
  /* 19) وحدة الحذاء: اللون وتطابق القدمين                                */
  /* ------------------------------------------------------------------ */
  function analyzeShoes(work, regions, extent) {
    var res = { id: 'shoes', title: 'الحذاء', state: 'unknown', confidence: 0.25, text: '', action: '', evidence: '', metrics: {} };
    var w = work.w, h = work.h, y, x, i;
    var feet = regions ? regions.feet : null;

    /* ١) الصدق أولاً: إن كانت قدماه خارج أسفل الكادر فلا نذكر لوناً ولا نحترعه */
    if (extent) {
      if (extent.bottom >= h - 6) {
        res.state = 'unknown'; res.confidence = 0.15;
        res.text = 'قدماك خارج أسفل الكادر، فلا أستطيع قراءة لون الحذاء.';
        res.action = 'ابتعد قليلاً أو انزل الهاتف حتى تظهر قدماك.';
        res.metrics.feetCutOff = true;
        return res;
      }
      if (!extent.mask) {
        res.text = 'لا أميّز الحذاء بوضوح في هذه اللقطة.';
        res.action = 'صوّر قدميك من قرب أكبر مع خلفية واضحة.';
        return res;
      }
      /* ٢) الحذاء = آخر صفوف ظلّ الشخص (٣٪ من ارتفاعه) */
      var bodyH = Math.max(1, extent.bottom - extent.top);
      var bandH = Math.max(3, Math.round(bodyH * 0.035));
      var rowStart = Math.max(0, extent.bottom - bandH + 1);
      var mask = extent.mask;
      var mid = extent.left + (extent.right - extent.left) / 2;
      function dominantInHalf(half) {
        var buckets = {}, total = 0;
        for (y = rowStart; y <= extent.bottom; y++) {
          for (x = extent.left; x < extent.right; x++) {
            i = y * w + x;
            if (!mask[i]) continue;
            if (half === 'L' && x > mid) continue;
            if (half === 'R' && x <= mid) continue;
            if (work.luma[i] > 250 || work.luma[i] < 6) continue;
            var key = (work.R[i] >> 3) * 1024 + (work.G[i] >> 3) * 32 + (work.B[i] >> 3);
            var bk = buckets[key] || (buckets[key] = { n: 0, sr: 0, sg: 0, sb: 0 });
            bk.n++; bk.sr += work.R[i]; bk.sg += work.G[i]; bk.sb += work.B[i];
            total++;
          }
        }
        if (!total) return null;
        var best = null;
        for (var k in buckets) if (!best || buckets[k].n > best.n) best = buckets[k];
        if (!best || best.n < Math.max(40, total * 0.22)) return null;
        return {
          n: best.n, total: total, share: best.n / total,
          r: Math.round(best.sr / best.n), g: Math.round(best.sg / best.n), b: Math.round(best.sb / best.n)
        };
      }
      var dl = dominantInHalf('L'), dr = dominantInHalf('R');
      var lName = dl ? classifyColorName(dl.r, dl.g, dl.b) : null;
      var rName = dr ? classifyColorName(dr.r, dr.g, dr.b) : null;
      res.metrics.leftColor = lName; res.metrics.rightColor = rName;
      res.metrics.leftPixels = dl ? dl.n : 0; res.metrics.rightPixels = dr ? dr.n : 0;
      res.metrics.leftShare = dl ? Math.round(dl.share * 100) / 100 : 0;
      res.metrics.rightShare = dr ? Math.round(dr.share * 100) / 100 : 0;
      function skinish(c) { return c && (c.r > 150 && c.g > 110 && c.b > 85 && c.r > c.b + 20); }
      if (skinish(dl) || skinish(dr)) {
        res.state = 'unknown'; res.confidence = 0.3;
        res.text = 'لا يظهر حذاء واضح في هذه اللقطة؛ قد تكون حافي القدمين.';
        res.action = 'إن كنت تلبس حذاءً فصوّر قدميك من قرب أكبر.';
        return res;
      }
      var msgs = [], acts = [];
      if (!lName && !rName) {
        res.state = 'unknown'; res.confidence = 0.2;
        res.text = 'لا أميّز الحذاء بوضوح في هذه اللقطة.';
        res.action = 'صوّر قدميك من قرب أكبر مع خلفية واضحة.';
        return res;
      }
      if (!lName) { msgs.push('لا يظهر الحذاء في قدمك اليمنى في هذه اللقطة.'); acts.push('وجّه الكاميرا إلى القدمين معاً.'); }
      if (!rName) { msgs.push('لا يظهر الحذاء في قدمك اليسرى في هذه اللقطة.'); acts.push('وجّه الكاميرا إلى القدمين معاً.'); }
      if (lName && rName) {
        if (lName === rName) {
          res.state = 'ok'; res.confidence = 0.55;
          res.text = 'لون الحذاء واحد في القدمين: ' + lName + '.';
        } else {
          res.state = 'attention'; res.confidence = 0.45;
          msgs.push('لون الحذاء مختلف بين القدمين: ' + lName + ' في قدمك اليمنى و' + rName + ' في قدمك اليسرى.');
          acts.push('بدّل الحذاء ليستوفي الشكل نفسه في القدمين.');
        }
      }
      if (msgs.length) { res.text = msgs.join(' '); res.action = acts.join(' '); }
      res.evidence = 'بكسلات أسفل القدم اليمنى ' + res.metrics.leftPixels + '، اليسرى ' + res.metrics.rightPixels;
      return res;
    }

    /* بلا ظلّ شخص: نبقى محافظين (نطاق القدمين فقط) */
    if (!feet || feet.w < 40 || feet.h < 20) { res.text = 'قدماك غير داخل الإطار.'; return res; }
    var buckets = {};
    for (y = feet.y; y < feet.y + feet.h; y++) {
      for (x = feet.x; x < feet.x + feet.w; x++) {
        i = y * w + x;
        if (work.luma[i] > 252 || work.luma[i] < 5) continue;
        var key2 = (work.R[i] >> 3) * 1024 + (work.G[i] >> 3) * 32 + (work.B[i] >> 3);
        var bk2 = buckets[key2] || (buckets[key2] = { n: 0, sr: 0, sg: 0, sb: 0 });
        bk2.n++; bk2.sr += work.R[i]; bk2.sg += work.G[i]; bk2.sb += work.B[i];
      }
    }
    var best2 = null;
    for (var k2 in buckets) if (!best2 || buckets[k2].n > best2.n) best2 = buckets[k2];
    if (!best2 || best2.n < 120) {
      res.state = 'unknown'; res.text = 'لا أميّز الحذاء بوضوح في هذه اللقطة.';
      res.action = 'صوّر قدميك من قرب أكبر مع خلفية واضحة.';
      return res;
    }
    var nm = classifyColorName(Math.round(best2.sr / best2.n), Math.round(best2.sg / best2.n), Math.round(best2.sb / best2.n));
    res.state = 'ok'; res.confidence = 0.35;
    res.metrics.leftColor = nm; res.metrics.rightColor = nm;
    res.text = 'لون الحذاء: ' + nm + '.';
    res.evidence = 'بكسلات ' + best2.n;
    return res;
  }

  /* ------------------------------------------------------------------ */
  /* 20) وحدة التجعّد (هل القماش مكوي؟)                                  */
  /* ------------------------------------------------------------------ */
  function analyzeWrinkles(work, regions, garment) {
    var res = { id: 'wrinkles', title: 'التجعّد', state: 'unknown', confidence: 0.2, text: '', action: '', evidence: '', metrics: {} };
    var r = regions ? (regions.chest || regions.torso) : null;
    if (!r || r.w < 30 || r.h < 30) { res.text = 'منطقة القماش غير داخل الإطار.'; return res; }
    var G = 6;
    var gw = Math.floor(r.w / G), gh = Math.floor(r.h / G);
    if (gw < 6 || gh < 6) { res.text = 'منطقة القماش صغيرة جداً في الصورة.'; return res; }
    var stds = [], cells = [], y, x, i, gy, gx;
    for (gy = 0; gy < G; gy++) {
      for (gx = 0; gx < G; gx++) {
        var vals = [];
        for (y = r.y + gy * gh; y < r.y + gy * gh + gh; y++) {
          for (x = r.x + gx * gw; x < r.x + gx * gw + gw; x++) {
            i = y * work.w + x;
            if (garment && garment.mask && !garment.mask[i]) continue;
            if (garment && garment.mask) {
              /* نتجاهل حافة القماش لأن ظلّها يشبه الثنية: نطلب جيراناً قماشيين */
              if (x + 1 >= work.w || y + 1 >= work.h) continue;
              if (!garment.mask[i + 1] || !garment.mask[i + work.w]) continue;
            }
            if (work.luma[i] > 250 || work.luma[i] < 8) continue;
            vals.push(work.luma[i]);
          }
        }
        if (vals.length < 25) continue;
        stds.push(stdevOf(vals));
        cells.push({ gx: gx, gy: gy, s: stdevOf(vals) });
      }
    }
    if (cells.length < 8) { res.text = 'تفاصيل القماش غير واضحة.'; return res; }
    var med = medianOf(stds);
    var strong = cells.filter(function (c) { return c.s > med * 1.45; });
    res.metrics.foldCells = strong.length;
    res.metrics.totalCells = cells.length;
    res.metrics.medianStd = med;
    if (!strong.length) {
      res.state = 'ok'; res.confidence = 0.35;
      res.text = 'القماش يبدو أملساً بلا ثنيات واضحة.';
    } else {
      res.state = 'attention'; res.confidence = 0.3;
      var side = strong[0].gx < G / 2 ? 'يمينك' : 'يسارك';
      var vert = strong[0].gy <= 1 ? 'أعلى صدرك' : (strong[0].gy >= 4 ? 'أسفل صدرك' : 'منتصف صدرك');
      res.text = 'توجد ثنية واضحة في القماش عند ' + vert + ' (' + side + ').';
      res.action = 'مرّر يدك على القماش أو مدّده إن كنت تريد مظهراً أنظف.';
    }
    res.evidence = 'خلايا فيها ثنية ' + strong.length + ' من ' + cells.length;
    return res;
  }

  /* ------------------------------------------------------------------ */
  /* 21) تناسق الطقم من ثلاث قطع                                         */
  /* ------------------------------------------------------------------ */
  function analyzeOutfitCombination(colors) {
    var res = { id: 'outfit', title: 'الطقم', state: 'unknown', confidence: 0.3, text: '', action: '', evidence: '', metrics: {} };
    var top = colors.top, bottom = colors.bottom, shoes = colors.shoes;
    if (!top && !bottom && !shoes) { res.text = 'لم أتمكّن من تحديد ألوان الملابس.'; return res; }
    var neutrals = ['أسود', 'أبيض', 'رمادي فاتح', 'رمادي غامق', 'كحلي', 'بني', 'بيج'];
    var parts = [];
    if (top) parts.push('الجزء العلوي ' + top);
    if (bottom) parts.push('الجزء السفلي ' + bottom);
    if (shoes) parts.push('الحذاء ' + shoes);
    res.text = 'ألوانك: ' + parts.join('، ') + '.';
    res.metrics.top = top || null; res.metrics.bottom = bottom || null; res.metrics.shoes = shoes || null;
    var msgs = [];
    if (top && bottom) {
      var tn = neutrals.indexOf(top) >= 0, bn = neutrals.indexOf(bottom) >= 0;
      if (tn && bn) msgs.push('قطعتان محايدتان، والمزج بينهما هادئ.');
      else if (tn || bn) msgs.push('القطعة المحايدة مع القطعة الملوّنة مزج متوازن.');
      else msgs.push('قطعتان لونان قويان معاً؛ إن كان هذا بقصدك فالتنسيق مقبول.');
    }
    if (shoes) {
      var sn = neutrals.indexOf(shoes) >= 0;
      if (sn) msgs.push('لون الحذاء محايد وينسجم مع most'.replace(' most', ' معظم الطقم'));
      else msgs.push('لون الحذاء قوي؛ تأكد أنه ينسجم مع باقي القطع.');
    }
    if (msgs.length) res.text += ' ' + msgs.join(' ');
    res.state = 'ok';
    res.kind = 'info';
    return res;
  }

  /* ------------------------------------------------------------------ */
  /* 22) جاهزية «صورة الجسم الكامل»: الهاتف على كرسي والمستخدم يبتعد   */
  /* ------------------------------------------------------------------ */

  /* لون الخلفية التقريبي: وسيط بكسلات إطار الصورة (الزوايا غالباً خلفية) */
  function estimateBackgroundColor(work) {
    var w = work.w, h = work.h, rs = [], gs = [], bs = [], x, y, i;
    var bw = Math.max(3, Math.round(w * 0.06)), bh = Math.max(3, Math.round(h * 0.06));
    function push(x, y) {
      if (x < 0 || y < 0 || x >= w || y >= h) return;
      i = y * w + x;
      if (work.luma[i] > 252 || work.luma[i] < 3) return;
      rs.push(work.R[i]); gs.push(work.G[i]); bs.push(work.B[i]);
    }
    for (y = 0; y < bh; y++) { for (x = 0; x < w; x += 2) { push(x, y); push(x, h - 1 - y); } }
    for (x = 0; x < bw; x++) { for (y = 0; y < h; y += 2) { push(x, y); push(w - 1 - x, y); } }
    if (rs.length < 50) return null;
    return { r: medianOf(rs), g: medianOf(gs), b: medianOf(bs) };
  }

  /* خلفية تقديرية لكل صف: وسيط حاشية الصف (الUsually أبعد عن الشخص) */
  function rowBackgroundModel(work) {
    var w = work.w, h = work.h, out = new Float32Array(h * 3), m, x, y, i;
    m = Math.max(3, Math.round(w * 0.07));
    for (y = 0; y < h; y++) {
      var rs = [], gs = [], bs = [];
      for (x = 0; x < m; x++) {
        var p1 = y * w + x, p2 = y * w + (w - 1 - x);
        if (work.luma[p1] > 252 || work.luma[p1] < 3) { } else { rs.push(work.R[p1]); gs.push(work.G[p1]); bs.push(work.B[p1]); }
        if (work.luma[p2] > 252 || work.luma[p2] < 3) { } else { rs.push(work.R[p2]); gs.push(work.G[p2]); bs.push(work.B[p2]); }
      }
      if (rs.length < 6) { out[y * 3] = 200; out[y * 3 + 1] = 200; out[y * 3 + 2] = 205; continue; }
      out[y * 3] = medianOf(rs); out[y * 3 + 1] = medianOf(gs); out[y * 3 + 2] = medianOf(bs);
    }
    return out;
  }

  /* أين ينتهي الشخص داخل الكادر؟ (هل تظهر قدماه أم تُقطعان) */
  function detectPersonExtent(work, box) {
    var w = work.w, h = work.h, n = w * h, x, y, i;
    var bgRow = rowBackgroundModel(work);
    var mask = new Uint8Array(n);
    for (y = 0; y < h; y++) {
      var br = bgRow[y * 3], bgc = bgRow[y * 3 + 1], bb = bgRow[y * 3 + 2];
      for (x = 0; x < w; x++) {
        i = y * w + x;
        if (work.luma[i] > 252 || work.luma[i] < 3) continue;
        if (Math.hypot(work.R[i] - br, work.G[i] - bgc, work.B[i] - bb) > 48) mask[i] = 1;
      }
    }
    var lab = labelComponents(mask, w, h);
    var best = null, bestOv = 0;
    for (var ci = 0; ci < lab.comps.length; ci++) {
      var comp = lab.comps[ci];
      if (comp.area < n * 0.004) continue;
      if (!box) {
        /* بلا وجه (لقطة الظهر): نختار أكبر مكوّن */
        if (!best || comp.area > best.area) best = comp;
        continue;
      }
      var ov = 0;
      for (var k = 0; k < comp.pixels.length; k++) {
        var px2 = comp.pixels[k] % w, py2 = (comp.pixels[k] / w) | 0;
        if (px2 >= box.x && px2 < box.x + box.w && py2 >= box.y && py2 < box.y + box.h) ov++;
      }
      if (ov > bestOv) { bestOv = ov; best = comp; }
    }
    if (!best) return null;
    var bbx = bboxOf(work, best.pixels);
    return {
      top: bbx.y, bottom: bbx.y + bbx.h, left: bbx.x, right: bbx.x + bbx.w,
      area: best.area, overlap: bestOv, pixels: best.pixels, mask: mask
    };
  }

  /* هل يظهر شخص في أسفل وسط الكادر؟ (القدمان داخل الإطار) */
  function detectFeetInFrame(work, bg) {
    if (!bg) return false;
    var w = work.w, h = work.h, y, x, i;
    var x0 = Math.round(w * 0.26), x1 = Math.round(w * 0.74);
    var y0 = Math.round(h * 0.88);
    var diff = 0, tot = 0;
    for (y = y0; y < h; y++) {
      for (x = x0; x < x1; x++) {
        i = y * w + x;
        if (work.luma[i] > 252 || work.luma[i] < 3) continue;
        tot++;
        if (Math.hypot(work.R[i] - bg.r, work.G[i] - bg.g, work.B[i] - bg.b) > 42) diff++;
      }
    }
    if (tot < 200) return false;
    return (diff / tot) > 0.16;
  }

  /* تقييم جاهزية الجسم الكامل: هل يستطيع سند التقاط صورة كاملة الآن؟ */
  function evaluateFullBodyFraming(work, box) {
    var res = { ok: false, code: '', hint: '', metrics: {} };
    if (!work) { res.hint = 'لا أستطيع قراءة الصورة الآن. حاول مرة أخرى.'; return res; }
    var w = work.w, h = work.h;
    if (!box) {
      res.code = 'noFace';
      res.hint = 'لم أجد وجهك بوضوح. قف في منتصف الكادر وانظر إلى العدسة، وإن كنت بعيداً فاقترب خطوة.';
      return res;
    }
    var fh = Math.max(1, box.h);
    var faceFrac = fh / h;
    res.metrics.faceHeightFrac = Math.round(faceFrac * 1000) / 1000;

    /* 1) أين ينتهي الشخص؟ هذا المقياس الأدق: هل تظهر قدماه أم تُقطعان */
    var ext = detectPersonExtent(work, box);
    if (ext) {
      res.metrics.personTop = ext.top;
      res.metrics.personBottom = ext.bottom;
      res.metrics.personLeft = ext.left;
      res.metrics.personRight = ext.right;
      var personH = ext.bottom - ext.top;
      res.metrics.personHeightFrac = Math.round((personH / h) * 1000) / 1000;
      var pcx = (ext.left + ext.right) / 2 / w;
      res.metrics.centerOffset = Math.round(Math.abs(pcx - 0.5) * 1000) / 1000;
      var cutOff = ext.bottom >= h - 6;
      res.metrics.feetVisible = !cutOff;
      if (Math.abs(pcx - 0.5) > 0.24) {
        res.code = 'offCenter';
        res.hint = 'انتقل قليلاً نحو منتصف الكادر.';
        return res;
      }
      if (cutOff) {
        res.code = 'tooClose';
        res.hint = 'ابتعد خطوة أخرى حتى تظهر قدماك أسفل الكادر.';
        return res;
      }
      if (personH < h * 0.50) {
        res.code = 'tooFar';
        res.hint = 'أنت بعيد جداً. اقترب خطوة نحو الهاتف.';
        return res;
      }
      res.ok = true; res.code = 'ready';
      res.hint = 'ممتاز، جسمك كامل في الكادر.';
      return res;
    }

    /* 2) بديل: تقدير نسبة الوجه من طول الجسم + وجود القدمين */
    var cx = (box.x + box.w / 2) / w;
    var off = Math.abs(cx - 0.5);
    res.metrics.centerOffset = Math.round(off * 1000) / 1000;
    if (off > 0.22) { res.code = 'offCenter'; res.hint = 'انتقل قليلاً نحو منتصف الكادر.'; return res; }
    if (faceFrac > 0.30) { res.code = 'tooClose'; res.hint = 'أنت قريب جداً. ابتعد خطوة أو خطوتين.'; return res; }
    if (faceFrac < 0.035) { res.code = 'tooFar'; res.hint = 'أنت بعيد جداً. اقترب خطوة نحو الهاتف.'; return res; }
    var bodyBottom = box.y + fh * 9.5;
    res.metrics.bodyBottom = Math.round(bodyBottom);
    var bg = estimateBackgroundColor(work);
    var feet = detectFeetInFrame(work, bg);
    res.metrics.feetVisible = feet;
    if (bodyBottom > h * 1.04) {
      res.code = 'tooClose';
      res.hint = 'ابتعد خطوة أخرى حتى يظهر جسمك كاملاً.';
      return res;
    }
    if (!feet) {
      res.code = 'noFeet';
      res.hint = faceFrac > 0.13 ? 'ابتعد حتى تظهر قدماك أسفل الكادر.' : 'انزل الهاتف قليلاً حتى تظهر قدماك أسفل الكادر.';
      return res;
    }
    res.ok = true; res.code = 'ready';
    res.hint = 'ممتاز، جسمك كامل في الكادر.';
    return res;
  }

  /* ------------------------------------------------------------------ */
  /* 23) فحص تأطير كل مرحلة من مراحل المرآة (خمس مراحل)                     */
  /* ------------------------------------------------------------------ */
  /* stage: 'face' | 'upper' | 'lower' | 'full' | 'back'                  */
  function evaluateStageFraming(work, box, extent, stage) {
    var res = { ok: false, code: '', hint: '', metrics: {} };
    if (!work) { res.hint = 'لا أستطيع قراءة الصورة الآن.'; return res; }
    var w = work.w, h = work.h;
    var faceFrac = box ? box.h / h : 0;
    var personH = extent ? (extent.bottom - extent.top) : 0;
    var personFrac = personH / h;
    var feetVisible = extent ? (extent.bottom < h - 6) : false;
    res.metrics.faceHeightFrac = Math.round(faceFrac * 1000) / 1000;
    res.metrics.personHeightFrac = Math.round(personFrac * 1000) / 1000;
    res.metrics.feetVisible = feetVisible;

    if (stage === 'back') {
      if (!extent) { res.code = 'noPerson'; res.hint = 'لا أرى جسمك في الكادر. قف في المنتصف.'; return res; }
      if (box) { res.code = 'stillFront'; res.hint = 'استدر حتى أريك ظهرك، ثم سآخذ اللقطة.'; return res; }
      res.ok = true; res.code = 'ready';
      res.hint = 'ممتاز، أرى ظهرك.';
      return res;
    }

    if (stage === 'face') {
      if (!box) { res.code = 'noFace'; res.hint = 'لم أجد وجهك. ارفع الهاتف أمام وجهك قليلاً.'; return res; }
      var cx = (box.x + box.w / 2) / w;
      var off = Math.abs(cx - 0.5);
      res.metrics.centerOffset = Math.round(off * 1000) / 1000;
      var headTop = box.y;
      var chin = box.y + box.h;
      if (headTop <= 2) { res.code = 'headCut'; res.hint = 'ارفع رأسك قليلاً، أعلى رأسك خارج الصورة.'; return res; }
      if (chin >= h - 4) { res.code = 'chinCut'; res.hint = 'ارفع الهاتف قليلاً، ذقنك خارج الصورة.'; return res; }
      if (off > 0.18) {
        res.code = 'offCenter';
        res.hint = cx < 0.5 ? 'اتجه قليلاً إلى اليمين نحو منتصف الكادر.' : 'اتجه قليلاً إلى اليسار نحو منتصف الكادر.';
        return res;
      }
      if (faceFrac < 0.060) { res.code = 'tooFar'; res.hint = 'اقترب خطوة، وجّه الهاتف أقرب إلى وجهك.'; return res; }
      if (faceFrac > 0.34) { res.code = 'tooClose'; res.hint = 'ابتعد قليلاً، أنت قريب جداً من الكاميرا.'; return res; }
      res.ok = true; res.code = 'ready';
      res.hint = 'ممتاز، وجهك واضح في الكادر.';
      return res;
    }

    if (stage === 'upper') {
      if (!extent) { res.code = 'noPerson'; res.hint = 'لا أرى جسمك. قف في منتصف الكادر وارجع قليلاً.'; return res; }
      if (box && box.h / h > 0.28) { res.code = 'tooClose'; res.hint = 'ابتعد خطوة، أحتاج أن أرى صدرك لا وجهك فقط.'; return res; }
      if (personFrac < 0.42) { res.code = 'tooFar'; res.hint = 'اقترب خطوة، أحتاج أن أرى صدرك وياقتك.'; return res; }
      if (!feetVisible && personFrac > 0.92) { res.code = 'tooClose'; res.hint = 'ابتعد خطوة أخرى حتى يظهر جسمك.'; return res; }
      res.ok = true; res.code = 'ready';
      res.hint = 'ممتاز، أرى الجزء العلوي بوضوح.';
      return res;
    }

    if (stage === 'lower') {
      if (!extent) { res.code = 'noPerson'; res.hint = 'لا أرى جسمك. قف في منتصف الكادر.'; return res; }
      if (!feetVisible) {
        res.code = 'noFeet';
        res.hint = personFrac > 0.55 ? 'ابتعد قليلاً حتى تظهر قدماك.' : 'انزل الهاتف قليلاً حتى تظهر قدماك.';
        return res;
      }
      if (personFrac < 0.40) { res.code = 'tooFar'; res.hint = 'اقترب خطوة، أحتاج أن أرى ساقيك وقدميك.'; return res; }
      res.ok = true; res.code = 'ready';
      res.hint = 'ممتاز، أرى قدميك.';
      return res;
    }

    /* full */
    if (!extent) { res.code = 'noPerson'; res.hint = 'لا أرى جسمك. قف في منتصف الكادر وارجع.'; return res; }
    if (!feetVisible) { res.code = 'noFeet'; res.hint = 'ابتعد خطوة أخرى حتى تظهر قدماك أسفل الكادر.'; return res; }
    if (personFrac < 0.60) { res.code = 'tooFar'; res.hint = 'ابتعد قليلاً حتى يظهر جسمك كاملاً.'; return res; }
    res.ok = true; res.code = 'ready';
    res.hint = 'ممتاز، جسمك كامل في الكادر.';
    return res;
  }

  /* لقطة سريعة لتقييم الجاهزية (بلا تحليل كامل) */
  function analyzeFullBodyFraming(source, maxDim) {
    var work = buildWorkingImage(source, maxDim || 480);
    return detectFaceBoxNative(source).then(function (nat) {
      var box = null;
      if (nat) {
        box = { x: nat.nx * work.w, y: nat.ny * work.h, w: nat.nw * work.w, h: nat.nh * work.h, conf: nat.conf, src: 'native' };
      } else {
        box = detectFaceBoxBySkin(work);
      }
      var extent = detectPersonExtent(work, box);
      var fr = evaluateFullBodyFraming(work, box);
      fr.work = work; fr.box = box; fr.extent = extent;
      return fr;
    });
  }

  var api = {
    VERSION: 'V20.11',
    buildWorkingImage: buildWorkingImage,
    buildWorkFromImageData: buildWorkFromImageData,
    sourceSize: sourceSize,
    detectFaceBoxNative: detectFaceBoxNative,
    detectFaceBoxBySkin: detectFaceBoxBySkin,
    buildSkinMask: buildSkinMask,
    buildRegions: buildRegions,
    computeGradients: computeGradients,
    computeTensor: computeTensor,
    morph3: morph3,
    checkFraming: checkFraming,
    checkLighting: checkLighting,
    analyzeHair: analyzeHair,
    analyzeGlasses: analyzeGlasses,
    analyzeSpots: analyzeSpots,
    composeReport: composeReport,
    classifyColorName: classifyColorName,
    dominantColor: dominantColor,
    buildShotRegions: buildShotRegions,
    analyzeBeard: analyzeBeard,
    analyzeHeadCover: analyzeHeadCover,
    analyzeBodyCoverage: analyzeBodyCoverage,
    analyzeTuck: analyzeTuck,
    analyzeShoes: analyzeShoes,
    analyzeWrinkles: analyzeWrinkles,
    analyzeOutfitCombination: analyzeOutfitCombination,
    estimateBackgroundColor: estimateBackgroundColor,
    detectFeetInFrame: detectFeetInFrame,
    evaluateFullBodyFraming: evaluateFullBodyFraming,
    rowBackgroundModel: rowBackgroundModel,
    detectPersonExtent: detectPersonExtent,
    evaluateStageFraming: evaluateStageFraming,
    analyzeFullBodyFraming: analyzeFullBodyFraming,
    buildGarmentMask: buildGarmentMask,
    fillHoles: fillHoles,
    runInspection: runInspection,
    clipRect: clipRect,
    medianOf: medianOf
  };
  global.SanadMirror = api;
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; module.exports.SanadMirror = api; }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
