import json
from pathlib import Path
import socket
import tempfile
import threading
import time
import unittest
from uuid import uuid4

from fastapi.testclient import TestClient
from playwright.sync_api import sync_playwright, expect
import uvicorn

from image_workbench import StorageConfig, StorageManager
from image_workbench.accounts import IdentityStore, password_matches
from image_workbench.web import create_app


class ImageTrialTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='image-trials-')
        self.addCleanup(self.temp.cleanup)
        self.storage = StorageManager(StorageConfig(Path(self.temp.name)))
        self.app = create_app(self.storage, backend='local')
        self.identity = self.app.identity
        self.entries = [{'username': 'trial001', 'password': 'test-Trial-001-random'},
                        {'username': 'trial002', 'password': 'test-Trial-002-random'}]
        self.batch = uuid4().hex
        self.accounts = self.identity.provision_image_trials(self.entries, batch_id=self.batch)

    def client(self, entry):
        client = TestClient(self.app, base_url='http://localhost')
        self.addCleanup(client.close)
        csrf = client.get('/api/auth/config').json()['csrf_token']
        response = client.post('/api/auth/login', json=entry, headers={'X-Workbench-CSRF': csrf})
        self.assertEqual(response.status_code, 200)
        client.headers['X-Workbench-CSRF'] = client.get('/api/auth/config').json()['csrf_token']
        return client

    def test_exact_grant_hashing_restart_and_idempotent_batch(self):
        with self.identity.connect() as db:
            rows = db.execute("SELECT a.*,t.initial_credit FROM accounts a JOIN image_trial_accounts t USING(account_id)").fetchall()
        self.assertEqual(len(rows), 2)
        for row in rows:
            entry = next(item for item in self.entries if item['username'] == row['username'])
            self.assertNotEqual(row['password_hash'], entry['password'])
            self.assertTrue(password_matches(entry['password'], row['password_hash']))
            self.assertEqual(self.identity.wallet(row['account_id'])['remaining_credit'], 8000)
            ledger = self.identity.ledger(row['account_id'])
            self.assertEqual([(item['type'], item['amount']) for item in ledger], [('initial_grant', 8000)])
        restarted = IdentityStore(self.storage)
        replay = restarted.provision_image_trials(self.entries, batch_id=self.batch)
        self.assertEqual({x['account_id'] for x in replay}, {x['account_id'] for x in self.accounts})
        self.assertEqual(len(restarted.ledger(self.accounts[0]['account_id'])), 1)
        with self.assertRaises(ValueError):
            restarted.provision_image_trials(self.entries, batch_id=self.batch, initial_credit=8200)

    def test_collision_and_invalid_batch_do_not_create_partial_accounts(self):
        mixed = [{'username': 'new_trial', 'password': 'a-valid-test-password'}, self.entries[0]]
        with self.assertRaises(ValueError):
            self.identity.provision_image_trials(mixed, batch_id=uuid4().hex)
        with self.identity.connect() as db:
            self.assertIsNone(db.execute("SELECT 1 FROM accounts WHERE username='new_trial'").fetchone())
        for entries in ([self.entries[0], self.entries[0]], [{'username': 'moy', 'password': 'a-valid-test-password'}],
                        [{'username': 'new_trial', 'password': 'short'}]):
            with self.assertRaises(ValueError):
                self.identity.provision_image_trials(entries, batch_id=uuid4().hex)

    def test_image_access_and_backend_restrictions_follow_account_across_workspaces(self):
        client = self.client(self.entries[0])
        me = client.get('/api/auth/me').json()
        self.assertTrue(me['image_only'])
        self.assertFalse(me['is_admin'])
        self.assertEqual(me['credits']['remaining_credit'], 8000)
        html = client.get('/').text
        self.assertNotIn('href="/scripts"', html)
        self.assertNotIn('href="/video"', html)
        self.assertEqual(client.get('/api/config').status_code, 200)
        project = client.post('/api/main-projects', json={'name': 'image trial', 'request_id': uuid4().hex})
        self.assertEqual(project.status_code, 200, project.text)
        for method, path in [('GET', '/scripts'), ('GET', '/video'), ('GET', '/scripts/'),
                             ('GET', '/api/scripts/config'), ('POST', '/api/scripts/tasks'),
                             ('POST', '/api/video/projects'), ('GET', '/api/video/config'),
                             ('POST', '/api/video/projects/from-subproject'), ('POST', '/api/storyboards'),
                             ('POST', '/api/storyboards/test/plan')]:
            with self.subTest(method=method, path=path):
                response = client.request(method, path, json={} if method == 'POST' else None)
                self.assertEqual(response.status_code, 403)
                self.assertEqual(response.json()['code'], 'feature_not_enabled')
        self.assertEqual(client.post('/api/prompt-enhancements', json={}).status_code, 422)
        self.assertEqual(client.get('/api/admin/config').status_code, 403)
        wid = client.post('/api/workspaces', json={'name': 'another workspace'}).json()['workspace_id']
        self.assertEqual(client.post('/api/workspaces/select', json={'workspace_id': wid}).status_code, 200)
        self.assertTrue(client.get('/api/auth/me').json()['image_only'])
        self.assertEqual(client.get('/api/video/config').status_code, 403)
        self.assertEqual(self.identity.wallet(me['account_id'])['remaining_credit'], 8000)
        other = self.client(self.entries[1])
        self.assertEqual(other.get('/api/main-projects', headers={'X-Workspace-ID': wid}).status_code, 404)

    def test_admin_and_existing_regular_accounts_keep_access(self):
        activation = json.loads((Path(self.temp.name)/'.identity/moy-activation.json').read_text())
        self.identity.activate(activation['activation_token'], 'admin-test-password')
        self.identity.register('normal_account', 'normal-test-password')
        for entry in [{'username': 'moy', 'password': 'admin-test-password'},
                      {'username': 'normal_account', 'password': 'normal-test-password'}]:
            client = self.client(entry)
            self.assertFalse(client.get('/api/auth/me').json()['image_only'])
            html = client.get('/').text
            self.assertIn('href="/scripts"', html)
            self.assertIn('href="/video"', html)
            self.assertEqual(client.get('/scripts').status_code, 200)
            self.assertEqual(client.get('/video').status_code, 200)
            self.assertEqual(client.get('/api/video/config').status_code, 200)

    def test_browser_trial_navigation_and_admin_navigation(self):
        activation = json.loads((Path(self.temp.name)/'.identity/moy-activation.json').read_text())
        self.identity.activate(activation['activation_token'], 'admin-test-password')
        sock = socket.socket()
        sock.bind(('127.0.0.1', 0))
        origin = 'http://127.0.0.1:' + str(sock.getsockname()[1])
        server = uvicorn.Server(uvicorn.Config(self.app, log_level='error', lifespan='off'))
        thread = threading.Thread(target=server.run, kwargs={'sockets': [sock]}, daemon=True)
        thread.start()
        try:
            deadline = time.monotonic() + 10
            while not server.started:
                self.assertLess(time.monotonic(), deadline)
                time.sleep(.05)
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(headless=True)
                try:
                    for username, password, restricted in [('trial001', self.entries[0]['password'], True),
                                                           ('moy', 'admin-test-password', False)]:
                        context = browser.new_context()
                        token = self.identity.login(username, password)
                        context.add_cookies([{'name': 'iw_session', 'value': token, 'url': origin}])
                        page = context.new_page()
                        page.goto(origin)
                        expect(page.locator('#accountName')).to_contain_text(username)
                        expect(page.locator('a[href="/scripts"]')).to_have_count(0 if restricted else 1)
                        expect(page.locator('a[href="/video"]')).to_have_count(0 if restricted else 1)
                        if restricted:
                            expect(page.locator('#creditSummary')).to_contain_text('8000')
                        context.close()
                finally:
                    browser.close()
        finally:
            server.should_exit = True
            thread.join(10)
            sock.close()


if __name__ == '__main__':
    unittest.main()
