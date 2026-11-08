import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { renderReportHtml, renderReportPdf } from "../src/lib/reports/render";
import { sampleReport } from "../tests/fixtures/report";

async function main() {
  const dir = resolve("artifacts");
  await mkdir(dir, { recursive: true });
  await writeFile(resolve(dir, "weekly-sample.html"), renderReportHtml(sampleReport));
  await writeFile(resolve(dir, "weekly-sample.pdf"), await renderReportPdf(sampleReport));
  console.log("Synthetic sample: artifacts/weekly-sample.html and artifacts/weekly-sample.pdf");
}
main().catch(() => { console.error("Sample rendering failed"); process.exitCode = 1; });
