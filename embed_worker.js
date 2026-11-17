/* سند — عامل الرؤية (Web Worker من نوع module): DINOv2 للبصمات + SegFormer للمكان، بعيداً عن الخيط الرئيسي.
   - DINOv2-small (q8, wasm): نفس النموذج والإعدادات وصيغة البصمة (CLS + متوسط الرقع = 768) المستخدمة في
     index.html و build_pack.html، فتبقى بصمات الحزم صالحة دون إعادة بناء.
   - SegFormer-b0 ADE (q8, wasm): يُستدعى النموذج مباشرة بلا pipeline، ويُؤخذ argmax على شبكة logits
     بدقة الربع. الـpipeline الأصلي كان يرفع logits الأصناف الـ150 إلى حجم الصورة ثم يبني قناعاً كاملاً لكل صنف.
   - طابور واحد لكل الطلبات: لا استدلالان متداخلان، فتبقى ميزانية المعالج قابلة للضبط.
   البروتوكول:
     ← {type:'alive'}                         عند اكتمال تحميل السكربت
     → {type:'init'}                          ← {type:'ready'} | {type:'init-error', message}          (DINOv2)
     → {type:'embed', id, blob}               ← {id, ok:true, vec:Float32Array(768), ms} | {id, ok:false, message}
     → {type:'seg-init'}                      ← {type:'seg-ready', id2label, nativeSize} | {type:'seg-init-error', message}
     → {type:'seg', id, w, h, buf}            ← {id, ok:true, labels:Uint8Array(gw*gh), gw, gh, ms, fallback} | {id, ok:false, message}
        (buf = بكسلات RGBA بحجم w×h؛ يُغيَّر حجم المعالج إلى w×h، وعند رفض النموذج للحجم يعود تلقائياً للحجم الأصلي) */
const TRANSFORMERS_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2';
const DINO_ID = 'Xenova/dinov2-small';
const SEG_ID = 'Xenova/segformer-b0-finetuned-ade-512-512';

function normVec(v) {
  let s = 0; for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  s = Math.sqrt(s) || 1;
  const o = new Float32Array(v.length); for (let i = 0; i < v.length; i++) o[i] = v[i] / s;
  return o;
}
// مطابقة حرفية لـ SanadLive.reduceEmbedding (يتحقق منها livetest.js)
function reduceEmbedding(dims, data) {
  const D = dims[dims.length - 1], N = dims.length >= 3 ? dims[dims.length - 2] : 1;
  const cls = normVec(data.slice(0, D)), mean = new Float32Array(D);
  if (N > 1) { for (let t = 1; t < N; t++) for (let i = 0; i < D; i++) mean[i] += data[t * D + i] / (N - 1); }
  const both = new Float32Array(2 * D); both.set(cls, 0); both.set(normVec(N > 1 ? mean : cls), D);
  return normVec(both);
}

// قابل للاستبدال في الاختبارات؛ في الإنتاج يستورد المكتبة المثبّتة نفسها التي يستوردها index.html (فيخدمها الـSW من الكاش).
self.__loadTransformers = self.__loadTransformers || (() => import(TRANSFORMERS_URL));

let modPromise = null;
function getMod() {
  if (!modPromise) {
    modPromise = (async () => {
      const mod = await self.__loadTransformers();
      mod.env.allowLocalModels = false;
      mod.env.allowRemoteModels = true;
      mod.env.useBrowserCache = true;
      if ('useWasmCache' in mod.env) mod.env.useWasmCache = true;
      if (mod.env.backends && mod.env.backends.onnx && mod.env.backends.onnx.wasm) {
        mod.env.backends.onnx.wasm.numThreads = 1;
        mod.env.backends.onnx.wasm.proxy = false;
      }
      return mod;
    })().catch(e => { modPromise = null; throw e; });
  }
  return modPromise;
}

/* ---------- DINOv2 ---------- */
let extractor = null, initPromise = null;
function init() {
  if (extractor) return Promise.resolve(extractor);
  if (!initPromise) {
    initPromise = (async () => {
      const mod = await getMod();
      extractor = await mod.pipeline('image-feature-extraction', DINO_ID, { device: 'wasm', dtype: 'q8' });
      return extractor;
    })().catch(e => { initPromise = null; throw e; });
  }
  return initPromise;
}

/* ---------- SegFormer المباشر ---------- */
let seg = null, segInitPromise = null, segCustomOk = true;
function initSeg() {
  if (seg) return Promise.resolve(seg);
  if (!segInitPromise) {
    segInitPromise = (async () => {
      const mod = await getMod();
      const [processor, model] = await Promise.all([
        mod.AutoProcessor.from_pretrained(SEG_ID),
        mod.AutoModelForSemanticSegmentation.from_pretrained(SEG_ID, { device: 'wasm', dtype: 'q8' })
      ]);
      seg = { mod, processor, model, id2label: (model.config && model.config.id2label) || {}, nativeSize: processor.size };
      return seg;
    })().catch(e => { segInitPromise = null; throw e; });
  }
  return segInitPromise;
}
const isShapeError = e => /dimension|shape|expected|invalid/i.test(String((e && e.message) || e));

async function runSeg(m) {
  const s = await initSeg();
  const t0 = Date.now();
  const img = new s.mod.RawImage(new Uint8ClampedArray(m.buf), m.w, m.h, 4);   // بلا JPEG: البكسلات مباشرة
  const attempt = async size => {
    s.processor.size = size;
    const inputs = await s.processor(img);
    const names = s.model.sessions && s.model.sessions['model'] ? s.model.sessions['model'].inputNames : ['pixel_values'];
    if (!names.includes('pixel_values')) {
      if (names.length !== 1) throw new Error('Expected a single input name, but got ' + names.length);
      inputs[names[0]] = inputs.pixel_values;
    }
    return s.model(inputs);
  };
  let out = null, fallback = false;
  if (segCustomOk) {
    try { out = await attempt({ width: m.w, height: m.h }); }
    catch (e) { if (!isShapeError(e)) throw e; segCustomOk = false; fallback = true; }   // الملف لا يقبل غير حجمه الأصلي
  } else { fallback = true; }
  if (!out) out = await attempt(s.nativeSize);
  const logits = out.logits, dims = logits.dims, C = dims[1], gh = dims[2], gw = dims[3], data = logits.data, hw = gh * gw;
  const labels = new Uint8Array(hw);
  for (let p = 0; p < hw; p++) {
    let bi = 0, bv = data[p];
    for (let c = 1; c < C; c++) { const v = data[c * hw + p]; if (v > bv) { bv = v; bi = c; } }
    labels[p] = bi;
  }
  // ms = زمن الحساب الفعلي داخل العامل (بلا انتظار الطابور)
  return { labels, gw, gh, ms: Date.now() - t0, fallback };
}

const errText = e => String((e && e.message) || e);

async function handle(m) {
  if (m.type === 'init') {
    try { await init(); self.postMessage({ type: 'ready' }); }
    catch (e) { self.postMessage({ type: 'init-error', message: errText(e) }); }
    return;
  }
  if (m.type === 'embed') {
    try {
      const ex = await init();
      const t0 = Date.now();
      const out = await ex(m.blob);
      const vec = reduceEmbedding(out.dims, out.data);
      self.postMessage({ id: m.id, ok: true, vec, ms: Date.now() - t0 }, [vec.buffer]);
    } catch (e) {
      self.postMessage({ id: m.id, ok: false, message: errText(e) });
    }
    return;
  }
  if (m.type === 'seg-init') {
    try { const s = await initSeg(); self.postMessage({ type: 'seg-ready', id2label: s.id2label, nativeSize: s.nativeSize }); }
    catch (e) { self.postMessage({ type: 'seg-init-error', message: errText(e) }); }
    return;
  }
  if (m.type === 'seg') {
    try {
      const r = await runSeg(m);
      self.postMessage({ id: m.id, ok: true, labels: r.labels, gw: r.gw, gh: r.gh, ms: r.ms, fallback: r.fallback }, [r.labels.buffer]);
    } catch (e) {
      self.postMessage({ id: m.id, ok: false, message: errText(e) });
    }
  }
}

let chain = Promise.resolve();
self.onmessage = ev => { const m = ev.data || {}; chain = chain.then(() => handle(m)).catch(() => {}); };
self.postMessage({ type: 'alive' });
