import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { attachResume } from "../src/submission/browser.js";

/**
 * Greenhouse's current job board holds its file inputs in a React widget that
 * only initializes when its "Attach" control is clicked. Setting files on the
 * input directly ran the change handler against an uninitialized component:
 * the page logged "Cannot read properties of undefined (reading 'uploadFile')"
 * and no resume was held, while the upload reported success.
 */
const GREENHOUSE_FORM = `
<div class="file-upload">
  <label>Resume/CV</label>
  <button type="button" onclick="window.widget = {}; document.getElementById('resume').click()">Attach</button>
  <input type="file" id="resume" style="display:none"
    onchange="if (window.widget) document.getElementById('held').textContent = this.files[0].name">
  <span id="held"></span>
</div>
<div class="file-upload">
  <label>Cover Letter</label>
  <button type="button">Attach</button>
</div>`;

describe("attachResume on Greenhouse's React upload widget", () => {
  let browser: Browser;
  let dir: string;
  let resumePath: string;
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    dir = mkdtempSync(join(tmpdir(), "autoapply-attach-"));
    resumePath = join(dir, "alex-kim-resume.pdf");
    writeFileSync(resumePath, "%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n");
  });
  afterAll(async () => {
    await browser.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("uploads through the Resume section's Attach control so the widget holds the file", async () => {
    const page = await browser.newPage();
    await page.route("**/*", (route) => route.fulfill({ contentType: "text/html", body: GREENHOUSE_FORM }));
    await page.goto("https://job-boards.greenhouse.io/fixture/jobs/1");

    const attached = await attachResume(page as unknown as Parameters<typeof attachResume>[0], resumePath);

    expect(attached).toBe(true);
    expect(await page.locator("#held").textContent()).toBe("alex-kim-resume.pdf");
    await page.close();
  });
});
