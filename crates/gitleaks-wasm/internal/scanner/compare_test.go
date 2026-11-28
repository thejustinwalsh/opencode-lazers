package scanner

import (
	"encoding/json"
	"strings"
	"testing"
)

const (
	awsKey = "AKIA" + "QYLPMN5H" + "HHFPZAM2"
	salt   = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
)

func requestFor(baseFiles, headFiles []File, changed map[string][]LineRange) Request {
	return Request{
		ComparisonID:    "comparison-1",
		BaseRevision:    "base-revision",
		HeadRevision:    "head-revision",
		Salt:            salt,
		Base:            Side{Files: baseFiles},
		Head:            Side{Files: headFiles},
		HeadChanges:     changed,
		BaseComplete:    true,
		HeadComplete:    true,
		ChangesComplete: true,
	}
}

func TestScanRedactsAndClassifiesIntroducedSecret(t *testing.T) {
	base := []File{{Path: "src/config.ts", Content: "export const region = 'eu';\n"}}
	head := []File{{
		Path:    "src/config.ts",
		Content: "export const region = 'eu';\nexport const key = \"" + awsKey + "\";\n",
	}}
	input := requestFor(base, head, map[string][]LineRange{"src/config.ts": {{2, 2}}})
	result, code := Scan(input)
	if code != "" {
		t.Fatalf("Scan returned %q", code)
	}
	if len(result.Introduced) != 1 || result.Introduced[0].Rule != "aws-access-token" {
		t.Fatalf("unexpected introduced findings: %#v", result.Introduced)
	}
	finding := result.Introduced[0]
	if finding.Location.StartLine != 2 || finding.Location.StartCol != 0 {
		t.Fatalf("unexpected location: %#v", finding.Location)
	}
	if finding.Masked != "AKI********AM2" || finding.Fingerprint == "" {
		t.Fatalf("unexpected redacted projection: %#v", finding)
	}
	encoded, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), awsKey) {
		t.Fatalf("serialized result contains the matched secret: %s", encoded)
	}
}

func TestScanDoesNotReportMovedSecretAndCountsCopies(t *testing.T) {
	base := []File{{
		Path:    "src/a.ts",
		Content: "const key = \"" + awsKey + "\";\nconst count = 1;\n",
	}}
	head := []File{
		{Path: "src/a.ts", Content: "const key = \"" + awsKey + "\";\nconst count = 2;\n"},
		{Path: "src/b.ts", Content: "const key = \"" + awsKey + "\";\n"},
	}
	input := requestFor(base, head, map[string][]LineRange{
		"src/a.ts": {{2, 2}},
		"src/b.ts": {{1, 1}},
	})
	result, code := Scan(input)
	if code != "" {
		t.Fatalf("Scan returned %q", code)
	}
	if len(result.Introduced) != 1 || result.Introduced[0].Location.Path != "src/b.ts" {
		t.Fatalf("expected only the copied secret, got %#v", result.Introduced)
	}
}

func TestScanUsesSideConfigIgnoreAndInlineAllow(t *testing.T) {
	content := "export const key = \"" + awsKey + "\"; // gitleaks:allow\n"
	input := requestFor(nil, []File{{Path: "src/config.ts", Content: content}}, map[string][]LineRange{
		"src/config.ts": {{1, 1}},
	})
	result, code := Scan(input)
	if code != "" {
		t.Fatalf("Scan returned %q", code)
	}
	if len(result.Introduced) != 0 || len(result.Inline) != 1 || len(result.Inline[0].Matches) != 1 {
		t.Fatalf("unexpected inline allow result: %#v", result)
	}

	input.Head.Files[0].Content = "export const key = \"" + awsKey + "\";\n"
	input.Head.Ignore = "src/config.ts:aws-access-token:1\n"
	result, code = Scan(input)
	if code != "" {
		t.Fatalf("Scan with ignore returned %q", code)
	}
	if len(result.Introduced) != 0 {
		t.Fatalf("ignore did not suppress finding: %#v", result.Introduced)
	}
}

func TestScanReportsAllowlistEffectWithBaseRules(t *testing.T) {
	headConfig := "[extend]\nuseDefault = true\n\n[[allowlists]]\npaths = ['''^src/config\\.ts$''']\n"
	base := []File{{Path: "src/config.ts", Content: "export {};\n"}}
	head := []File{{Path: "src/config.ts", Content: "export {};\nexport const key = \"" + awsKey + "\";\n"}}
	input := requestFor(base, head, map[string][]LineRange{"src/config.ts": {{2, 2}}})
	input.Head.Config = headConfig
	input.Head.ConfigPresent = true
	input.ChangedFiles = []ChangedFile{{Path: ".gitleaks.toml", Status: "added"}}
	input.HeadChanges[".gitleaks.toml"] = []LineRange{{1, 6}}
	result, code := Scan(input)
	if code != "" {
		t.Fatalf("Scan with custom config returned %q", code)
	}
	if len(result.Introduced) != 0 {
		t.Fatalf("head config did not apply: %#v", result.Introduced)
	}
	if result.Allowlist == nil || result.Allowlist.LeftOut != 1 || result.Allowlist.Total != 1 {
		t.Fatalf("expected the base rule set to expose one hidden match: %#v", result.Allowlist)
	}
	if len(result.Allowlist.Added) != 1 || result.Allowlist.Added[0] != "path ^src/config\\.ts$" {
		t.Fatalf("unexpected allowlist additions: %#v", result.Allowlist.Added)
	}
}

func TestScanSkipsInvalidConfigWhenNoFilesNeedScanning(t *testing.T) {
	input := requestFor(nil, nil, nil)
	input.Head.Config = "not toml [[[\n"
	input.Head.ConfigPresent = true
	input.ChangedFiles = []ChangedFile{{Path: ".gitleaks.toml", Status: "added"}}

	result, code := Scan(input)
	if code != "" {
		t.Fatalf("Scan returned %q", code)
	}
	if result.Allowlist == nil || result.Allowlist.LeftOut != 0 {
		t.Fatalf("expected allowlist change without file scans, got %#v", result.Allowlist)
	}
}

func TestScanMakesFindingsUnclassifiedWhenChangesAreUnavailable(t *testing.T) {
	input := requestFor(nil, []File{{
		Path:    "src/config.ts",
		Content: "const key = \"" + awsKey + "\";\n",
	}}, nil)
	input.ChangesComplete = false
	result, code := Scan(input)
	if code != "" {
		t.Fatalf("Scan returned %q", code)
	}
	if len(result.Introduced) != 0 || len(result.Unclassified) != 1 {
		t.Fatalf("expected one unclassified finding, got %#v", result)
	}
}

func TestScanRejectsUnsafePathsWithoutEchoingInput(t *testing.T) {
	input := requestFor(nil, []File{{Path: "../secret", Content: awsKey}}, map[string][]LineRange{})
	_, code := Scan(input)
	if code != "invalid-input" {
		t.Fatalf("expected generic invalid-input, got %q", code)
	}
}
