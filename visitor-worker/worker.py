"""Local RTSP age analytics. Only an age band, time and random event ID leave the worker."""
import os
os.environ['OPENCV_LOG_LEVEL'] = 'SILENT'
os.environ['OPENCV_FFMPEG_LOGLEVEL'] = '-8'
os.environ['OPENCV_FFMPEG_CAPTURE_OPTIONS'] = 'rtsp_transport;tcp'
import json
import sqlite3
import threading
import time
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from tracker import Tracker

BASE = os.environ.get('VISITOR_API_URL', 'http://app:3000').rstrip('/')
TOKEN = os.environ.get('VISITOR_INGEST_TOKEN', '')
if len(TOKEN) < 32:
    raise RuntimeError('Configure VISITOR_INGEST_TOKEN (32+ characters)')

def api(path, data=None):
    request = Request(BASE + '/internal/visitors/' + path,
                      data=json.dumps(data).encode() if data is not None else None,
                      headers={'Authorization': 'Bearer '+TOKEN, 'Content-Type': 'application/json'})
    with urlopen(request, timeout=5) as response:
        return json.load(response)

def status(state):
    try:
        api('status', {'state': state})
    except Exception:
        pass


class Capture:
    """Continuously consume RTSP; inference takes only the latest decoded frame."""
    def __init__(self, cv2, url):
        self.lock = threading.Lock()
        self.frame = None
        self.at = 0
        self.stopped = False
        self.cap = cv2.VideoCapture(url, cv2.CAP_FFMPEG, [cv2.CAP_PROP_OPEN_TIMEOUT_MSEC, 8000, cv2.CAP_PROP_READ_TIMEOUT_MSEC, 8000])
        self.thread = threading.Thread(target=self.run, daemon=True)
        self.thread.start()

    def run(self):
        try:
            while not self.stopped:
                ok, frame = self.cap.read()
                if not ok:
                    break
                with self.lock:
                    self.frame, self.at = frame, time.time()
        finally:
            self.cap.release()

    def latest(self):
        with self.lock:
            return self.frame, self.at

    def close(self):
        self.stopped = True
        self.thread.join(timeout=10)


def run():
    try:
        import cv2
        import numpy as np
        from openvino import Core
        core = Core()
        models = Path(__file__).parent / 'models'
        face = core.compile_model(str(models / 'face-detection-retail-0004.xml'), 'CPU')
        age = core.compile_model(str(models / 'age-gender-recognition-retail-0013.xml'), 'CPU')
        # The scalar output is age / 100; the two-element gender output is ignored.
        age_output = next(o for o in age.outputs if np.prod(o.shape) == 1)
    except Exception:
        status('model_error')
        raise RuntimeError('Install dependencies and run download_models.py') from None
    outdir = Path(os.environ.get('VISITOR_DATA_DIR', '/data'))
    outdir.mkdir(parents=True, exist_ok=True)
    queue = sqlite3.connect(outdir / 'outbox.sqlite')
    queue.execute('CREATE TABLE IF NOT EXISTS pending(id TEXT PRIMARY KEY, at INTEGER, payload TEXT)')
    config, capture, tracker = None, None, None
    next_config, next_status, next_flush, last_frame = 0, 0, 0, 0
    try:
        while True:
            now = time.time()
            if now >= next_config:
                next_config = now + 10
                try:
                    new_config = api('config')
                except Exception:
                    # Stop analysis when server configuration cannot be verified.
                    new_config = {'enabled': False}
                if new_config != config:
                    if capture:
                        capture.close()
                    config, capture, tracker, last_frame = new_config, None, None, 0
                if config.get('enabled') and capture is None:
                    capture = Capture(cv2, config['rtsp'])
                    tracker = Tracker(config['axis'], config['line'], config['direction'])
            frame, frame_at = capture.latest() if capture else (None, 0)
            fresh = frame is not None and now - frame_at < 3
            if now >= next_status:
                status('idle' if not config.get('enabled') else 'running' if fresh else 'camera_error')
                next_status = now + 10
            if capture and not capture.thread.is_alive() and not fresh:
                capture.close()
                capture, tracker = None, None
            if fresh and frame_at > last_frame:
                last_frame = frame_at
                height, width = frame.shape[:2]
                tensor = cv2.resize(frame, (300, 300)).transpose(2, 0, 1)[None].astype(np.float32)
                detections = []
                for d in face([tensor])[face.output(0)].reshape(-1, 7):
                    if d[0] < 0 or d[2] < 0.8:
                        continue
                    x1, y1, x2, y2 = (max(0, min(1, float(v))) for v in d[3:7])
                    crop = frame[int(y1*height):int(y2*height), int(x1*width):int(x2*width)]
                    if crop.size == 0:
                        continue
                    estimated = None
                    if min(crop.shape[:2]) >= 62 and cv2.Laplacian(cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY), cv2.CV_64F).var() >= 70:
                        tensor_age = cv2.resize(crop, (62, 62)).transpose(2, 0, 1)[None].astype(np.float32)
                        estimated = float(age([tensor_age])[age_output].reshape(-1)[0]) * 100
                    detections.append(((x1+x2)/2, (y1+y2)/2, estimated))
                for event in tracker.update(detections, frame_at):
                    event.update(camera=config['camera'], revision=config['revision'])
                    queue.execute('INSERT OR IGNORE INTO pending VALUES(?,?,?)', (event['id'], event['at'], json.dumps(event)))
                queue.commit()
            if now >= next_flush:
                next_flush = now + 5
                queue.execute('DELETE FROM pending WHERE at<?', (int((now-86400)*1000),))
                for key, payload in queue.execute('SELECT id,payload FROM pending ORDER BY at LIMIT 20').fetchall():
                    try:
                        api('event', json.loads(payload))
                    except HTTPError as error:
                        if error.code not in (400, 409):
                            break
                    except Exception:
                        break
                    queue.execute('DELETE FROM pending WHERE id=?', (key,))
                queue.commit()
            time.sleep(0.1)
    finally:
        if capture:
            capture.close()
        queue.close()

if __name__ == '__main__':
    run()
