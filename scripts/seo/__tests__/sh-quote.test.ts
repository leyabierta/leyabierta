// Guards the quoting that makes `SEO_UMAMI_SSH_HOST` work. The bug it exists
// for: ssh joins everything after the host into ONE string that the remote
// shell re-splits, so an unquoted SQL statement arrived shredded
// (`zsh: no matches found: count(*)`, `command not found: group`) and the tab
// passed to psql's -F was swallowed as whitespace.
//
// Asserted as exact strings rather than by round-tripping through `sh`: the
// expected POSIX form is short enough to write down, and a unit test that
// spawns no subprocess can't be flaky in CI.
import { describe, expect, test } from "bun:test";
import { shQuote } from "../lib.ts";

describe("shQuote", () => {
	test("wraps the characters that broke the SQL in single quotes", () => {
		expect(shQuote("select count(*) from website_event")).toBe(
			"'select count(*) from website_event'",
		);
		expect(shQuote("group by url_path order by 2 desc")).toBe(
			"'group by url_path order by 2 desc'",
		);
		// psql's -F separator: a bare tab is whitespace to the remote shell.
		expect(shQuote("\t")).toBe("'\t'");
		expect(shQuote("*")).toBe("'*'");
		expect(shQuote("$HOME")).toBe("'$HOME'");
		expect(shQuote("`whoami`")).toBe("'`whoami`'");
	});

	test("closes, escapes and reopens around a single quote", () => {
		// The one case naive quoting gets wrong: 'it'\''s' is four concatenated
		// words to the shell, which parse back into the single argument "it's".
		expect(shQuote("it's")).toBe(String.raw`'it'\''s'`);
		expect(shQuote("where id = 'abc'")).toBe(
			String.raw`'where id = '\''abc'\'''`,
		);
	});

	test("quotes the empty string instead of dropping the argument", () => {
		expect(shQuote("")).toBe("''");
	});
});
