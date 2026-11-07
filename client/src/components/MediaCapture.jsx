import { useEffect, useRef, useState } from 'react';
import Icon from './Icon.jsx';
import { useDialog } from './Dialogs.jsx';

/** "2026-10-17 14.32" for naming captured files. */
function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}`;
}

function mediaError(err, what) {
  if (err?.name === 'NotAllowedError' || err?.name === 'SecurityError') {
    return `${what} access is blocked. Allow it for this site in the browser's settings, then try again.`;
  }
  if (err?.name === 'NotFoundError' || err?.name === 'OverconstrainedError') return `No ${what.toLowerCase()} was found on this device.`;
  if (err?.name === 'NotReadableError') return `The ${what.toLowerCase()} is in use by another app.`;
  return `Could not start the ${what.toLowerCase()}: ${err?.message || err}`;
}

export const canCapture = () => !!navigator.mediaDevices?.getUserMedia;

/** Stops every track of a stream. */
const stopStream = (s) => s?.getTracks().forEach((t) => t.stop());

/** Live camera preview with a shutter. Resolves (via close) to a JPEG File, or null. */
export function CameraDialog({ close }) {
  const video = useRef(null);
  const [facing, setFacing] = useState('environment');
  const [stream, setStream] = useState(null);
  const [error, setError] = useState(null);
  const [cameras, setCameras] = useState(0);
  const [shot, setShot] = useState(null); // { blob, url }

  useEffect(() => {
    let s = null;
    let alive = true;
    setError(null);
    navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: facing }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    }).then((st) => {
      if (!alive) { stopStream(st); return; }
      s = st;
      setStream(st);
      navigator.mediaDevices.enumerateDevices()
        .then((list) => alive && setCameras(list.filter((d) => d.kind === 'videoinput').length))
        .catch(() => {});
    }).catch((e) => alive && setError(mediaError(e, 'Camera')));
    return () => { alive = false; stopStream(s); };
  }, [facing]);

  useEffect(() => {
    if (video.current && stream) video.current.srcObject = stream;
  }, [stream, shot]);

  useEffect(() => () => shot && URL.revokeObjectURL(shot.url), [shot]);

  const userFacing = stream?.getVideoTracks()[0]?.getSettings().facingMode === 'user' || facing === 'user';

  const capture = () => {
    const v = video.current;
    if (!v?.videoWidth) return;
    const c = document.createElement('canvas');
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext('2d').drawImage(v, 0, 0);
    c.toBlob((blob) => blob && setShot({ blob, url: URL.createObjectURL(blob) }), 'image/jpeg', 0.92);
  };

  const use = () => close(new File([shot.blob], `Photo ${stamp()}.jpg`, { type: 'image/jpeg' }));

  return (
    <div className="capture-dialog">
      <h2>Take photo</h2>
      {error ? <p className="form-error">{error}</p> : (
        <div className="camera-frame">
          {shot
            ? <img src={shot.url} alt="Captured" />
            : <video ref={video} autoPlay playsInline muted className={userFacing ? 'is-mirrored' : ''} />}
        </div>
      )}
      <div className="modal-actions spread">
        <span>
          {!shot && cameras > 1 && (
            <button type="button" className="btn" onClick={() => setFacing(facing === 'user' ? 'environment' : 'user')}>
              <Icon name="flip" size={16} /> Switch camera
            </button>
          )}
        </span>
        <span className="modal-actions-group">
          <button type="button" className="btn" onClick={() => close(null)}>Cancel</button>
          {shot ? (
            <>
              <button type="button" className="btn" onClick={() => setShot(null)}>Retake</button>
              <button type="button" className="btn btn-primary" onClick={use}>Insert photo</button>
            </>
          ) : (
            <button type="button" className="btn btn-primary" disabled={!stream || !!error} onClick={capture}>
              <Icon name="camera" size={16} /> Capture
            </button>
          )}
        </span>
      </div>
    </div>
  );
}

const AUDIO_TYPES = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
const EXT = { 'audio/mp4': 'm4a', 'audio/webm': 'webm', 'audio/ogg': 'ogg' };

function formatTime(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Microphone recorder. Resolves (via close) to an audio File, or null. */
export function RecorderDialog({ close }) {
  const dialog = useDialog();
  const [state, setState] = useState('starting'); // starting | ready | recording | paused | done | error
  const [error, setError] = useState(null);
  const [elapsed, setElapsed] = useState(0);
  const [result, setResult] = useState(null); // { blob, url, type }
  const meter = useRef(null);
  const rec = useRef({});

  // Open the microphone and run the level meter for as long as the dialog is open.
  useEffect(() => {
    let alive = true;
    const r = rec.current;
    navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }).then((stream) => {
      if (!alive) { stopStream(stream); return; }
      r.stream = stream;
      try {
        r.audioCtx = new AudioContext();
        const analyser = r.audioCtx.createAnalyser();
        analyser.fftSize = 1024;
        r.audioCtx.createMediaStreamSource(stream).connect(analyser);
        const buf = new Float32Array(analyser.fftSize);
        const tick = () => {
          analyser.getFloatTimeDomainData(buf);
          let sum = 0;
          for (const v of buf) sum += v * v;
          const level = Math.min(1, Math.sqrt(sum / buf.length) * 4);
          if (meter.current) meter.current.style.transform = `scaleX(${level})`;
          r.raf = requestAnimationFrame(tick);
        };
        tick();
      } catch { /* the meter is optional */ }
      setState('ready');
    }).catch((e) => { if (alive) { setError(mediaError(e, 'Microphone')); setState('error'); } });
    return () => {
      alive = false;
      cancelAnimationFrame(r.raf);
      clearInterval(r.timer);
      if (r.recorder?.state !== 'inactive') r.recorder?.stop();
      stopStream(r.stream);
      r.audioCtx?.close().catch(() => {});
      r.wakeLock?.release().catch(() => {});
    };
  }, []);

  useEffect(() => () => result && URL.revokeObjectURL(result.url), [result]);

  const clock = () => {
    const r = rec.current;
    return r.total + (r.since ? performance.now() - r.since : 0);
  };

  const start = async () => {
    const r = rec.current;
    const type = AUDIO_TYPES.find((t) => window.MediaRecorder?.isTypeSupported?.(t)) ?? '';
    let recorder;
    try {
      recorder = new MediaRecorder(r.stream, type ? { mimeType: type } : undefined);
    } catch (e) {
      setError(`Recording isn't supported in this browser (${e.message}).`);
      setState('error');
      return;
    }
    const chunks = [];
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    recorder.onstop = () => {
      const blobType = (recorder.mimeType || type || 'audio/webm').split(';')[0];
      const blob = new Blob(chunks, { type: blobType });
      setResult({ blob, url: URL.createObjectURL(blob), type: blobType });
      setState('done');
    };
    r.recorder = recorder;
    r.total = 0;
    r.since = performance.now();
    recorder.start(1000);
    setElapsed(0);
    setResult(null);
    setState('recording');
    clearInterval(r.timer);
    r.timer = setInterval(() => setElapsed(clock()), 250);
    // Keep the screen (and so the recording) awake on phones and tablets.
    try { r.wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* not available */ }
  };

  const pause = () => {
    const r = rec.current;
    r.recorder.pause();
    r.total = clock();
    r.since = 0;
    setState('paused');
  };

  const resume = () => {
    const r = rec.current;
    r.recorder.resume();
    r.since = performance.now();
    setState('recording');
  };

  const stop = () => {
    const r = rec.current;
    setElapsed(clock());
    r.total = clock();
    r.since = 0;
    clearInterval(r.timer);
    r.recorder.stop();
    r.wakeLock?.release().catch(() => {});
    r.wakeLock = null;
  };

  const use = () => {
    const ext = EXT[result.type] ?? 'webm';
    close(new File([result.blob], `Recording ${stamp()}.${ext}`, { type: result.type }));
  };

  const busy = state === 'recording' || state === 'paused';
  const discard = async () => {
    if ((busy || result) && !await dialog.confirm({ title: 'Discard recording?', okLabel: 'Discard', danger: true })) return;
    close(null);
  };

  return (
    <div className="capture-dialog recorder">
      <h2>Record audio</h2>
      {state === 'error' ? <p className="form-error">{error}</p> : (
        <>
          <div className={`recorder-time ${state === 'recording' ? 'is-live' : ''}`} aria-live="off">
            {state === 'recording' && <span className="rec-dot" aria-hidden="true" />}
            {formatTime(elapsed)}
            {state === 'paused' && <span className="muted"> paused</span>}
          </div>
          <div className="level-meter" aria-hidden="true"><div ref={meter} className="level-bar" /></div>
          {result && <audio className="recorder-preview" controls src={result.url} />}
          <p className="modal-message recorder-hint">
            {state === 'starting' && 'Waiting for the microphone…'}
            {state === 'ready' && 'The bar moves when the microphone hears you.'}
            {busy && 'Keep this window open while recording.'}
            {state === 'done' && 'Listen back, then insert it into the note.'}
          </p>
        </>
      )}
      <div className="modal-actions">
        <button type="button" className="btn" onClick={discard}>{busy || result ? 'Discard' : 'Cancel'}</button>
        {state === 'ready' && (
          <button type="button" className="btn btn-primary" onClick={start}><Icon name="mic" size={16} /> Start recording</button>
        )}
        {state === 'recording' && <button type="button" className="btn" onClick={pause}><Icon name="pause" size={16} /> Pause</button>}
        {state === 'paused' && <button type="button" className="btn" onClick={resume}><Icon name="mic" size={16} /> Resume</button>}
        {busy && <button type="button" className="btn btn-primary" onClick={stop}><Icon name="stop" size={16} /> Stop</button>}
        {state === 'done' && (
          <>
            <button type="button" className="btn" onClick={start}>Record again</button>
            <button type="button" className="btn btn-primary" onClick={use}>Insert recording</button>
          </>
        )}
      </div>
    </div>
  );
}
