/* سند — عامل البصمات (Web Worker من نوع module).
   يشغّل DINOv2-small (q8, wasm) بعيداً عن الخيط الرئيسي، فلا يتجمّد الرصد ولا الصوت ولا الواجهة.
   النموذج والإعدادات وصيغة البصمة (CLS + متوسط الرقع = 768) مطابقة لما في index.html و build_pack.html،
   فتبقى بصمات الحزم صالحة دون إعادة بناء.
   البروتوكول:
     → {type:'init'}                    ← {type:'ready'} | {type:'init-error', message}
     → {type:'embed', id, blob}         ← {id, ok:true, vec:Float32Array(768), ms} | {id, ok:false, message}
   الطلبات تُنفَّذ بالتتابع (طابور واحد) كي لا تتداخل استدلالات ORT. */
const TRANSFORMERS_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2';
const MODEL_ID = 'Xenova/dinov2-small';

let extractor = null, initPromise = null;

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

function init() {
  if (extractor) return Promise.resolve(extractor);
  if (!initPromise) {
    initPromise = (async () => {
      const mod = await self.__loadTransformers();
      mod.env.allowLocalModels = false;
      mod.env.allowRemoteModels = true;
      mod.env.useBrowserCache = true;
      if ('useWasmCache' in mod.env) mod.env.useWasmCache = true;
      if (mod.env.backends && mod.env.backends.onnx && mod.env.backends.onnx.wasm) {
        mod.env.backends.onnx.wasm.numThreads = 1;
        mod.env.backends.onnx.wasm.proxy = false;
      }
      extractor = await mod.pipeline('image-feature-extraction', MODEL_ID, { device: 'wasm', dtype: 'q8' });
      return extractor;
    })().catch(e => { initPromise = null; throw e; });
  }
  return initPromise;
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
      // ms = زمن الحساب الفعلي داخل العامل (بلا انتظار الطابور) — تعتمد عليه الميزانية التكيّفية
      self.postMessage({ id: m.id, ok: true, vec, ms: Date.now() - t0 }, [vec.buffer]);
    } catch (e) {
      self.postMessage({ id: m.id, ok: false, message: errText(e) });
    }
  }
}

let chain = Promise.resolve();
self.onmessage = ev => { const m = ev.data || {}; chain = chain.then(() => handle(m)).catch(() => {}); };
