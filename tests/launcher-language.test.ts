import { expect, test } from "bun:test";
import { describeLauncher, launcherCommand } from "../src/launcher/commands.ts";
import { diagnosticText } from "../src/launcher/diagnostics.ts";
import { runtimeErrorText } from "../src/runtime/error-text.ts";

test("human command and diagnostic text use the live language", async () => {
	const saved = process.env.OMOMP_LANG;
	try {
		for (const [lang, usage, installed, error] of [
			["en", "Usage:", "installed:", "ticket operation failed"],
			["zh", "用法：", "已安装：", "工单操作失败"],
		] as const) {
			process.env.OMOMP_LANG = lang;
			expect(await launcherCommand(["unknown"])).toMatchObject({ ok: false, error: expect.stringContaining(usage) });
			expect(describeLauncher({ installed: false, loaded: false, responding: false, plist: "/tmp/launcher.plist" })).toContain(installed);
			expect(runtimeErrorText({ kind: "domain", error: { kind: "notFound", message: "Model-facing diagnostic" } })).toContain(error);
			expect(diagnosticText({ kind: "noInterpreter" })).toContain(lang === "zh" ? "解释器" : "interpreter");
		}
	} finally {
		if (saved === undefined) delete process.env.OMOMP_LANG;
		else process.env.OMOMP_LANG = saved;
	}
});
