package scanner

import (
	"context"
	"path"
	"sort"
	"strings"
	"unicode"
	"unicode/utf16"

	"github.com/zricethezav/gitleaks/v8/detect"
	"github.com/zricethezav/gitleaks/v8/report"
)

type rawScan struct {
	matches []rawMatch
}

func scanSide(side Side, neutralize bool, salt []byte) (rawScan, string) {
	if len(side.Files) == 0 {
		return rawScan{}, ""
	}
	detector, err := detectorFor(side)
	if err != nil {
		return rawScan{}, "invalid-config"
	}

	contents := make(map[string]string, len(side.Files))
	files := append([]File(nil), side.Files...)
	sort.Slice(files, func(i, j int) bool { return files[i].Path < files[j].Path })
	for _, file := range files {
		contents[file.Path] = file.Content
		content := file.Content
		if neutralize {
			content = strings.ReplaceAll(content, "gitleaks:allow", "gitleaks_allow")
		}
		fragment := detect.Fragment{
			Raw:       content,
			FilePath:  file.Path,
			StartLine: 1,
		}
		for _, finding := range detector.DetectContext(context.Background(), fragment) {
			detector.AddFinding(finding)
		}
	}

	matches := make([]rawMatch, 0)
	for _, finding := range detector.Findings() {
		source := contents[finding.File]
		span := matchedText(source, finding)
		lines := sourceLines(source)
		start := lineAt(lines, finding.StartLine)
		end := lineAt(lines, finding.EndLine)
		leading := len(start) - len(strings.TrimLeftFunc(start, unicode.IsSpace))
		match := rawMatch{
			rule:        finding.RuleID,
			description: finding.Description,
			path:        finding.File,
			startLine:   finding.StartLine,
			endLine:     finding.EndLine,
			startCol:    utf16Length(start[:leading]),
			endCol:      utf16Length(end),
			entropy:     finding.Entropy,
			hasEntropy:  finding.Entropy != 0,
			span:        span,
			masked:      maskSecret(span),
			fingerprint: fingerprint(salt, finding.RuleID, span),
		}
		matches = append(matches, match)
	}
	sort.Slice(matches, func(i, j int) bool {
		if matches[i].path != matches[j].path {
			return matches[i].path < matches[j].path
		}
		if matches[i].startLine != matches[j].startLine {
			return matches[i].startLine < matches[j].startLine
		}
		return matches[i].rule < matches[j].rule
	})
	return rawScan{matches: matches}, ""
}

func sourceLines(source string) []string {
	lines := strings.Split(source, "\n")
	for i, line := range lines {
		lines[i] = strings.TrimSuffix(line, "\r")
	}
	return lines
}

func lineAt(lines []string, number int) string {
	if number < 1 || number > len(lines) {
		return ""
	}
	return lines[number-1]
}

func utf16Length(value string) int {
	return len(utf16.Encode([]rune(value)))
}

func matchedText(source string, finding report.Finding) string {
	lines := sourceLines(source)
	line := func(number int) string { return lineAt(lines, number) }
	if finding.EndLine > finding.StartLine {
		parts := make([]string, 0, finding.EndLine-finding.StartLine+1)
		for number := finding.StartLine; number <= finding.EndLine; number++ {
			parts = append(parts, strings.TrimSpace(line(number)))
		}
		return strings.Join(parts, "\n")
	}

	text := line(finding.StartLine)
	if finding.StartColumn != 0 && finding.EndColumn != 0 {
		bytes := []byte(text)
		shift := 0
		if finding.StartLine > 1 {
			shift = 1
		}
		from := finding.StartColumn - 1 - shift
		to := finding.EndColumn - shift
		if from >= 0 && to > from && to <= len(bytes) {
			return string(bytes[from:to])
		}
	}
	return strings.TrimSpace(text)
}

func safePath(value string) bool {
	clean := path.Clean(value)
	return value != "" && clean == value && !path.IsAbs(value) && clean != "." &&
		clean != ".." && !strings.HasPrefix(clean, "../") &&
		!strings.ContainsAny(value, "\\\x00\r\n")
}
