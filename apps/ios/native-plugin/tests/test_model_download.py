"""Exercise the production Swift streaming delegate against a local HTTP server.
Run on macOS: python3 apps/ios/native-plugin/tests/test_model_download.py
Only Foundation is linked; this does not build Capacitor or the iOS app.
"""
import http.server
import json
from pathlib import Path
import subprocess
import tempfile
import threading
import time
import unittest


class DownloadTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.root = Path(cls.temp.name)
        source = (Path(__file__).parents[1] / 'ios/RealtimeAsrPlugin.swift').read_text()
        delegate = source[source.index('private final class ModelDownloadDelegate:'):]
        harness = r'''
let part = URL(fileURLWithPath: CommandLine.arguments[2])
var speeds: [Double] = []
private let delegate = ModelDownloadDelegate(part: part, metadata: URL(fileURLWithPath: part.path + ".json"),
                                     source: CommandLine.arguments[1]) { _, speed in speeds.append(speed) }
var request = URLRequest(url: URL(string: CommandLine.arguments[1])!)
if delegate.offset > 0, let tag = delegate.etag {
  request.setValue("bytes=\(delegate.offset)-", forHTTPHeaderField: "Range")
  request.setValue(tag, forHTTPHeaderField: "If-Range")
}
let session = URLSession(configuration: .default, delegate: delegate, delegateQueue: nil)
session.dataTask(with: request).resume()
if delegate.done.wait(timeout: .now() + 10) == .timedOut { fatalError("download timeout") }
session.finishTasksAndInvalidate()
let result: [String: Any] = ["failed": delegate.failure != nil, "total": delegate.total ?? -1,
                           "positiveSpeed": speeds.contains { $0 > 0 }]
print(String(data: try! JSONSerialization.data(withJSONObject: result), encoding: .utf8)!)
'''
        swift = cls.root / 'DelegateTest.swift'
        swift.write_text('import Foundation\n' + delegate + harness)
        cls.binary = cls.root / 'delegate-test'
        subprocess.run(['xcrun', 'swiftc', '-swift-version', '5', '-module-cache-path', str(cls.root / 'module-cache'), str(swift), '-o', str(cls.binary)], check=True)

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def run_download(self, status, headers, body, initial=b'abc', metadata=True):
        requests = []

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                requests.append(dict(self.headers))
                self.send_response(status)
                for name, value in headers.items():
                    self.send_header(name, value)
                self.end_headers()
                self.wfile.write(body)
                self.wfile.flush()
                if int(headers.get('Content-Length', len(body))) > len(body):
                    time.sleep(0.2)

            def log_message(self, *_):
                pass

        with http.server.HTTPServer(('127.0.0.1', 0), Handler) as server:
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            source = f'http://127.0.0.1:{server.server_port}/model'
            part = self.root / 'model.part'
            part.write_bytes(initial)
            sidecar = Path(str(part) + '.json')
            sidecar.unlink(missing_ok=True)
            if metadata:
                sidecar.write_text(json.dumps({'source': source, 'etag': '"v1"'}))
            result = subprocess.run([str(self.binary), source, str(part)], capture_output=True, text=True, check=True)
            server.shutdown()
            thread.join()
        return json.loads(result.stdout), part.read_bytes(), requests[0]

    def test_resume_appends_and_reports_network_speed(self):
        result, data, request = self.run_download(206, {'Content-Range': 'bytes 3-5/6', 'Content-Length': '3', 'ETag': '"v1"'}, b'def')
        self.assertFalse(result['failed'])
        self.assertEqual((data, result['total']), (b'abcdef', 6))
        self.assertEqual(request['Range'], 'bytes=3-')
        self.assertEqual(request['If-Range'], '"v1"')
        self.assertTrue(result['positiveSpeed'])

    def test_200_restarts_instead_of_appending(self):
        result, data, _ = self.run_download(200, {'Content-Length': '3', 'ETag': '"v2"'}, b'NEW')
        self.assertFalse(result['failed'])
        self.assertEqual(data, b'NEW')

    def test_416_ignores_error_body_and_exposes_size_for_verification(self):
        result, data, _ = self.run_download(416, {'Content-Range': 'bytes */3'}, b'error document')
        self.assertFalse(result['failed'])
        self.assertEqual((data, result['total']), (b'abc', 3))

    def test_416_mismatched_size_reaches_verifier(self):
        result, data, _ = self.run_download(416, {'Content-Range': 'bytes */2'}, b'error')
        self.assertFalse(result['failed'])
        self.assertNotEqual(len(data), result['total'])

    def test_invalid_range_preserves_partial(self):
        result, data, _ = self.run_download(206, {'Content-Range': 'bytes 1-3/6'}, b'bad')
        self.assertTrue(result['failed'])
        self.assertEqual(data, b'abc')

    def test_changed_etag_preserves_partial(self):
        result, data, _ = self.run_download(206, {'Content-Range': 'bytes 3-5/6', 'ETag': '"v2"'}, b'bad')
        self.assertTrue(result['failed'])
        self.assertEqual(data, b'abc')

    def test_interrupted_stream_keeps_written_bytes(self):
        payload = b'x' * (128 * 1024)
        result, data, _ = self.run_download(200, {'Content-Length': str(len(payload) * 2), 'ETag': '"v1"'}, payload)
        self.assertTrue(result['failed'])
        self.assertGreater(len(data), 0)
        self.assertTrue(payload.startswith(data))
        self.assertNotEqual(data, b'abc')

    def test_no_validator_restarts_without_range(self):
        result, data, request = self.run_download(200, {'Content-Length': '3'}, b'NEW', metadata=False)
        self.assertFalse(result['failed'])
        self.assertNotIn('Range', request)
        self.assertEqual(data, b'NEW')


if __name__ == '__main__':
    unittest.main()
