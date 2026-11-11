import json
import tempfile
import unittest
from pathlib import Path
from uuid import uuid4

import httpx

from image_workbench.online_video_worker import OnlineVideoWorker


def uid():
    return uuid4().hex


class Transport:
    def __init__(self):
        self.started = []
        self.completed = []
        self.uploaded = []
        self.fail_upload = False

    def start(self, manifest, attempt, prompt_id=None):
        self.started.append((attempt, prompt_id))

    def heartbeat(self, manifest):
        pass

    def upload(self, manifest, data, digest):
        self.uploaded.append((data, digest))
        if self.fail_upload:
            self.fail_upload = False
            raise ConnectionError('lost acknowledgement')

    def complete(self, manifest, result):
        self.completed.append(result)


class OnlineWorkerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.transport = Transport()
        self.requests = []
        self.fail_post = False
        self.now = 1000
        self.client = httpx.Client(transport=httpx.MockTransport(self.response))
        self.worker = OnlineVideoWorker(self.transport, 'test-key', uid(), Path(self.temp.name), client=self.client, clock=lambda: self.now)
        self.manifest = {'job_id': uid(), 'worker_id': uid(), 'claim_id': uid(), 'attempt_id': None, 'prompt_id': None,
                         'task': {'prompt': 'red square', 'aspect_ratio': 'landscape', 'duration': 5, 'width': 1280, 'height': 720}}

    def response(self, request):
        self.requests.append((request.method, request.url.path))
        if request.method == 'POST':
            if self.fail_post:
                raise httpx.ReadTimeout('uncertain submission', request=request)
            return httpx.Response(200, json={'id': '123', 'status': 'pending'})
        return httpx.Response(200, json={'status': 'succeeded', 'outputUrl': 'https://example.com/video.mp4'})

    def test_uncertain_post_never_submits_twice_after_restart(self):
        self.fail_post = True
        self.worker.process(self.manifest)
        self.assertEqual(self.transport.completed[-1]['status'], 'uncertain')
        self.worker.process(self.manifest)
        self.assertEqual(sum(method == 'POST' for method, _ in self.requests), 1)

    def test_capacity_rejection_settles_failure_even_after_lost_completion(self):
        calls = []
        def capacity(request):
            calls.append(request.method)
            return httpx.Response(503, json={'code': 'QUOTA_EXCEEDED', 'message': '当前算力已满，请稍后重试'})
        self.worker.client = httpx.Client(transport=httpx.MockTransport(capacity))
        self.addCleanup(self.worker.client.close)
        complete = self.transport.complete
        def lost_response(manifest, result):
            complete(manifest, result)
            raise httpx.ReadTimeout('lost completion response')
        self.transport.complete = lost_response
        with self.assertRaises(httpx.ReadTimeout):
            self.worker.process(self.manifest)
        journal = json.loads((Path(self.temp.name) / (self.manifest['job_id'] + '.json')).read_text())
        self.assertEqual(journal['phase'], 'rejected')
        self.assertEqual(journal['submission_diagnostic']['provider_code'], 'QUOTA_EXCEEDED')
        self.transport.complete = complete
        self.worker.process(self.manifest)
        self.assertEqual(calls, ['POST'])
        self.assertEqual(self.transport.completed[-1]['status'], 'failed')
        self.assertIn('算力已满', self.transport.completed[-1]['error'])

    def test_other_503_responses_remain_uncertain_without_replay(self):
        for body in ({'code': 'INTERNAL_ERROR'}, {'code': 'QUOTA_EXCEEDED'},
                     {'code': 'QUOTA_EXCEEDED', 'message': '当前算力已满，请稍后重试', 'id': '123'},
                     ['unavailable'], None):
            with self.subTest(body=body):
                self.manifest['job_id'] = uid()
                calls = []
                def unavailable(request, calls=calls, body=body):
                    calls.append(request.method)
                    return httpx.Response(503, json=body) if body is not None else httpx.Response(503, text='bad gateway')
                with httpx.Client(transport=httpx.MockTransport(unavailable)) as client:
                    self.worker.client = client
                    self.worker.process(self.manifest)
                    self.worker.process(self.manifest)
                self.assertEqual(calls, ['POST'])
                self.assertEqual(self.transport.completed[-1]['status'], 'uncertain')

    def test_recover_known_task_and_retry_same_output_after_lost_ack(self):
        self.worker.process(self.manifest)
        self.assertEqual(self.requests, [('POST', '/v1/videos/generations')])
        self.now += 301
        self.worker.download = lambda url: b'provider video'
        self.worker.resize = lambda data, width, height: b'processed video'
        self.transport.fail_upload = True
        with self.assertRaises(ConnectionError):
            self.worker.process(self.manifest)
        self.worker.download = lambda url: self.fail('should reuse saved output')
        self.worker.process(self.manifest)
        self.assertEqual(self.transport.uploaded[0], self.transport.uploaded[1])
        self.assertEqual(self.transport.completed[-1]['status'], 'succeeded')
        self.assertEqual(sum(method == 'POST' for method, _ in self.requests), 1)
        self.assertEqual(self.transport.started[-1][1], '123')


if __name__ == '__main__':
    unittest.main()
