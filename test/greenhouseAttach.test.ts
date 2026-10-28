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
 * and no resume was held, while the upload reported success. The markup is
 * GitLab's live board, reduced to the two upload sections.
 */
const uploadSection = (id: string, title: string) => `
<div role="group" aria-labelledby="upload-label-${id}" class="file-upload">
  <div id="upload-label-${id}" class="label upload-label">${title}</div>
  <div class="file-upload__wrapper"><div class="button-container"><div class="secondary-button"><div>
    <button type="button" class="btn btn--pill" onclick="window.widget_${id} = {}; document.getElementById('${id}').click()">Attach</button>
    <label class="visually-hidden" for="${id}">Attach</label>
    <input id="${id}" class="visually-hidden" type="file" accept=".pdf,.doc,.docx,.txt,.rtf"
      onchange="if (window.widget_${id}) document.getElementById('${id}-held').textContent = this.files[0].name"/>
  </div></div></div></div>
  <span id="${id}-held"></span>
</div>`;
const GREENHOUSE_FORM = uploadSection("resume", "Resume/CV") + uploadSection("cover_letter", "Cover Letter");

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
    expect(await page.locator("#resume-held").textContent()).toBe("alex-kim-resume.pdf");
    expect(await page.locator("#cover_letter-held").textContent()).toBe("");
    await page.close();
  });
});
