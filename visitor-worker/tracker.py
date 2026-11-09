"""Short-lived geometric tracks. No face embeddings or persistent identities."""
import math
import statistics
import uuid


def group(ages):
    if len(ages) < 3 or max(ages) - min(ages) > 15:
        return 'unknown'
    age = statistics.median(ages)
    if not math.isfinite(age) or not 18 <= age <= 75:
        return 'unknown'
    return '18–29' if age < 30 else '30–44' if age < 45 else '45–59' if age < 60 else '60–75'


class Tracker:
    def __init__(self, axis='y', line=0.5, direction='increasing'):
        self.axis = 0 if axis == 'x' else 1
        self.line = line
        self.sign = 1 if direction == 'increasing' else -1
        self.tracks = {}

    def update(self, detections, now):
        """detections: [(normalized centre x, y, estimated age or None)]."""
        self.tracks = {k: t for k, t in self.tracks.items() if now - t['last'] < 2}
        pairs = sorted((math.hypot(d[0]-t['x'], d[1]-t['y']), k, i)
                       for k, t in self.tracks.items() for i, d in enumerate(detections))
        assigned, used = {}, set()
        for distance, key, index in pairs:
            if distance < 0.18 and key not in used and index not in assigned:
                assigned[index] = key
                used.add(key)
        events = []
        for i, d in enumerate(detections):
            key = assigned.get(i, str(uuid.uuid4()))
            t = self.tracks.setdefault(key, dict(ages=[], outside=False, counted=False))
            t.update(x=d[0], y=d[1], last=now)
            if d[2] is not None and math.isfinite(d[2]):
                t['ages'] = (t['ages'] + [d[2]])[-15:]
            side = (d[self.axis] - self.line) * self.sign
            if side < -0.03:
                t['outside'] = True
            if side > 0.03 and t['outside'] and not t['counted']:
                t['counted'] = True
                events.append(dict(id=key, group=group(t['ages']), at=int(now*1000)))
        return events
