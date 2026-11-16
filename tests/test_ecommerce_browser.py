"""Browser, HTTP and queue coverage for a complete template-sized purchase."""
from pathlib import Path
import unittest
from playwright.sync_api import sync_playwright, expect
from image_workbench import LocalFileBackend
from image_workbench.worker import LocalWorker
from image_workbench.prompt_enhancement import MockPromptModel
from tests import test_asset_browser as helpers
from tests.test_video import png


class EcommerceBrowserTests(unittest.TestCase):
    stop_server = helpers.AssetBrowserTests.stop_server
    post = helpers.AssetBrowserTests.post
    get = helpers.AssetBrowserTests.get

    @classmethod
    def setUpClass(cls):
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch(headless=True)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()

    def setUp(self):
        helpers.AssetBrowserTests.setUp(self)
        self.app.prompt_enhancement_service.model = MockPromptModel()
        with self.app.identity.transaction() as db:
            db.execute("UPDATE credit_accounts SET total_credit=2000 WHERE account_id=?", (self.aid,))
        self.fixture = self.root / "product.png"
        self.fixture.write_bytes(png("tan"))

    def test_select_edit_submit_and_download(self):
        shots = Path(__file__).resolve().parents[1] / 'work/ecommerce-browser-v2'
        shots.mkdir(parents=True, exist_ok=True)
        self.page.goto(self.origin + "/")
        expect(self.page.locator(".suite-showcase-card")).to_have_count(2)
        expect(self.page.locator("#suiteShowcaseTitle")).to_be_in_viewport()
        expect(self.page.locator(".suite-showcase-card").last).to_contain_text("210 积分")
        self.page.screenshot(path=str(shots / 'workbench-desktop.png'), full_page=True)
        self.page.set_viewport_size({'width':390,'height':844})
        expect(self.page.locator("#suiteShowcaseTitle")).to_be_in_viewport()
        self.assertTrue(self.page.evaluate('document.documentElement.scrollWidth <= innerWidth'))
        self.page.screenshot(path=str(shots / 'workbench-mobile.png'), full_page=True)
        self.page.locator(".suite-showcase-card").last.click()
        expect(self.page.locator(".template")).to_have_count(2)
        expect(self.page.locator('[data-id="small-product"]')).to_have_attribute('aria-pressed', 'true')
        self.page.set_viewport_size({'width':1440,'height':1000})
        self.page.locator('.examples').last.locator('summary').click()
        expect(self.page.locator('.examples').last.locator('img')).to_have_count(7)
        self.page.screenshot(path=str(shots / 'templates-desktop.png'), full_page=True)
        expect(self.page.locator("#modelField")).to_be_hidden()
        self.page.locator("#product").fill("米白色无品牌保温杯，不添加容量或功效文字")
        self.page.locator("#files").set_input_files(str(self.fixture))
        self.page.locator("#plan").click()
        expect(self.page.locator(".slot textarea")).to_have_count(7)
        self.page.locator(".slot textarea").first.fill("保温杯白底首图，保持真实商品外形，无人物")
        with self.page.expect_response(lambda r: r.url.endswith('/api/prompt-enhancements')) as enhanced:
            self.page.locator(".slot button").first.click()
        response = enhanced.value.json()
        self.assertEqual(response["skill"]["skill_id"], "ecommerce-small-product-editor")
        self.assertEqual(response["status"], "enhanced")
        with self.page.expect_response(lambda r: r.request.method == 'POST' and r.url.endswith('/suites'), timeout=60000) as submitted:
            self.page.locator("#submit").evaluate("b => { b.click(); b.click(); }")
        self.assertEqual(submitted.value.status, 200)
        suite = submitted.value.json()
        expect(self.page.locator(".result")).to_have_count(7, timeout=30000)
        self.assertEqual(self.app.identity.wallet(self.aid)["frozen_credit"], 210)
        worker = LocalWorker(self.app.state.workbench, LocalFileBackend([self.fixture]))
        self.assertTrue(worker.run_next())
        self.page.locator("#refresh").click()
        expect(self.page.locator(".result img")).to_have_count(1)
        with self.page.expect_download() as download:
            self.page.get_by_text("下载已完成图片 ZIP", exact=True).click()
        self.assertTrue(download.value.suggested_filename.endswith('.zip'))
        shots = Path(__file__).resolve().parents[1] / 'work/ecommerce-browser'
        shots.mkdir(parents=True, exist_ok=True)
        self.page.screenshot(path=str(shots / 'desktop.png'), full_page=True)
        self.page.set_viewport_size({'width':390,'height':844})
        self.page.screenshot(path=str(shots / 'mobile.png'), full_page=True)
        self.assertEqual(self.page.evaluate('document.documentElement.scrollWidth <= innerWidth'), True)
        self.assertEqual(self.errors, [])
        self.assertEqual(len(suite['tasks']), 7)
