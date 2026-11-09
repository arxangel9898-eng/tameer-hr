import unittest
from tracker import Tracker, group

class Tests(unittest.TestCase):
    def test_entry_once_jitter_exit_and_reentry(self):
        tracker = Tracker()
        events = []
        for i, y in enumerate([.4, .43, .48, .51, .55, .49, .56, .44, .55]):
            events += tracker.update([(.5, y, 35)], i * .1)
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]['group'], '30–44')

    def test_exit_or_appearing_inside_does_not_count(self):
        for coords in [[.6,.5,.4], [.6,.65,.7]]:
            tracker = Tracker()
            self.assertEqual(sum(len(tracker.update([(.5,y,40)], i*.1)) for i,y in enumerate(coords)), 0)

    def test_axis_direction_two_people_and_expiry(self):
        tracker = Tracker('x', .5, 'decreasing')
        result = []
        for i,x in enumerate([.6,.57,.51,.45]):
            result += tracker.update([(x,.2,65),(x,.8,None)], i*.1)
        self.assertEqual(len(result),2)
        self.assertEqual({r['group'] for r in result},{'60–75','unknown'})
        self.assertEqual(tracker.update([(.4,.2,65)],5),[])

    def test_unknown_for_bad_or_insufficient_samples(self):
        for ages in [[],[30,31],[20,50,60],[16,17,16],[76,80,81]]:
            self.assertEqual(group(ages),'unknown')
        self.assertEqual(group([28,29,30]),'18–29')

if __name__ == '__main__':
    unittest.main()
