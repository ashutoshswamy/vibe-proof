import assert from "node:assert/strict";
import fs from "node:fs";
import { chromium } from "playwright-core";

(async () => {
  const browser = await chromium.launch({ channel: "msedge" });
  try {
    const page = await browser.newPage({ reducedMotion: "reduce" });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async text => { window.copiedPrompt = text; } } });
    });
    await page.goto(process.env.UI_BASE_URL || "http://localhost:3000", { waitUntil: "networkidle" });
    await page.evaluate(() => document.fonts.ready);
    fs.mkdirSync(".taste-skill/verification", { recursive: true });

    for (const theme of ["light", "dark"]) {
      await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
      for (const width of [1440, 768, 390]) {
        await page.setViewportSize({ width, height: 900 });
        await page.evaluate(() => scrollTo(0, 0));
        const metrics = await page.evaluate(() => {
          const heading = document.querySelector("h1");
          const style = getComputedStyle(heading);
          return {
            overflow: document.documentElement.scrollWidth > innerWidth,
            lines: heading.getBoundingClientRect().height / parseFloat(style.lineHeight),
            fontLoaded: document.fonts.check(`48px ${style.fontFamily.split(",")[0]}`),
            hidden: [...document.querySelectorAll("[data-reveal] > *")].some(el => getComputedStyle(el).opacity === "0"),
            alert: getComputedStyle(document.querySelector(".lp-cell.failed")).backgroundColor,
            navPosition: getComputedStyle(document.querySelector(".lp-nav")).position,
            buttonRadius: parseFloat(getComputedStyle(document.querySelector(".lp-primary")).borderRadius),
            wordmarks: [...document.querySelectorAll(".wordmark")].map(el => [getComputedStyle(el.querySelector(".brand-vibe")).color, getComputedStyle(el.querySelector(".brand-accent")).color]),
          };
        });
        assert.equal(metrics.overflow, false, `${theme} ${width}: overflow`);
        assert.ok(metrics.lines < 2.5, `${theme} ${width}: headline wraps`);
        assert.ok(metrics.fontLoaded, "Display font loaded");
        assert.equal(metrics.hidden, false, "Reduced motion leaves content visible");
        assert.equal(metrics.alert, theme === "dark" ? "rgb(229, 72, 77)" : "rgb(220, 38, 38)", "Theme-specific alert color");
        assert.equal(metrics.navPosition, "sticky");
        assert.ok(metrics.buttonRadius >= 99, "Rounded primary action");
        for (const colors of metrics.wordmarks) assert.deepEqual(colors, ["rgb(0, 0, 0)", "rgb(2, 31, 148)"], "Consistent wordmark colors in both themes");
        await page.screenshot({ path: `.taste-skill/verification/${theme}-${width}.png`, fullPage: true });
      }
    }

    await page.locator('.lp-nav a[href="#checks"]').click();
    const anchorVisible = await page.evaluate(() => document.querySelector("#checks").getBoundingClientRect().top >= document.querySelector(".lp-nav").getBoundingClientRect().bottom);
    assert.ok(anchorVisible, "Floating navigation does not cover anchor content");
    await page.waitForTimeout(100);
    assert.equal(await page.locator('.lp-nav a[href="#checks"]').getAttribute("aria-current"), "location");

    assert.equal(await page.locator(".check-index li").count(), 82);
    assert.equal(await page.locator(".lp-grid button").count(), 82);
    const firstCheck = page.locator(".lp-grid button").first();
    await firstCheck.focus();
    await page.keyboard.press("ArrowRight");
    assert.equal(await page.locator(".lp-grid button").nth(1).evaluate(el => el === document.activeElement), true);
    await page.keyboard.press("End");
    assert.equal(await page.locator(".lp-grid button").last().evaluate(el => el === document.activeElement), true);
    assert.notEqual(await page.locator(".lp-readout").textContent(), "Choose a check to see what it verifies.");

    const secondArea = page.locator(".check-index details").nth(1);
    await secondArea.locator("summary").focus();
    await page.keyboard.press("Enter");
    assert.equal(await secondArea.evaluate(el => el.open), true);
    assert.equal(await page.locator(".check-index details[open]").count(), 1);

    await page.getByRole("button", { name: "Copy fix prompt" }).click();
    assert.match(await page.locator(".copy-status").textContent(), /Prompt copied/);
    assert.match(await page.evaluate(() => window.copiedPrompt), /Content-Security-Policy/);
    await page.evaluate(() => { navigator.clipboard.writeText = async () => { throw new Error("Denied"); }; });
    await page.getByRole("button", { name: "Copy fix prompt" }).click();
    assert.match(await page.locator(".copy-status").textContent(), /Select the prompt text/);

    await page.getByRole("button", { name: "Toggle light and dark theme" }).click();
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "light");
    await page.reload({ waitUntil: "networkidle" });
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "light");

    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.setViewportSize({ width: 1440, height: 900 });
    const height = await page.evaluate(() => document.body.scrollHeight);
    for (let top = 0; top < height; top += 700) {
      await page.evaluate(y => scrollTo({ top: y, behavior: "instant" }), top);
      await page.waitForTimeout(100);
    }
    await page.waitForTimeout(1000);
    assert.equal(await page.locator("[data-reveal] > *").evaluateAll(els => els.some(el => getComputedStyle(el).opacity === "0")), false);
    await page.emulateMedia({ reducedMotion: "reduce" });
    assert.equal(await page.locator(".report-stage").evaluate(el => getComputedStyle(el).transform), "none");
    assert.equal(await page.locator(".footer-wordmark .brand-vibe").evaluate(el => getComputedStyle(el).transform), "none");
    assert.deepEqual(errors, []);
    console.log("PASS: six responsive/theme views, font, 82 checks, keyboard navigation, disclosures, clipboard success/failure, theme persistence, GSAP and reduced motion.");
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
