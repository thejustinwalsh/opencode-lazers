package scanner

import (
	"encoding/hex"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode/utf16"
)

var (
	tomlValue     = regexp.MustCompile(`'''([^']*)'''|'([^']*)'|"([^"]*)"`)
	tomlRuleID    = regexp.MustCompile(`^id\s*=\s*["']([^"']{1,80})["']`)
	tomlPaths     = regexp.MustCompile(`^paths\s*=`)
	tomlRegexes   = regexp.MustCompile(`^regexes\s*=`)
	tomlStopwords = regexp.MustCompile(`^stopwords\s*=`)
)

func Scan(input Request) (Result, string) {
	if !validRequest(input) {
		return Result{}, "invalid-input"
	}
	salt, _ := hex.DecodeString(input.Salt)
	base, code := scanSide(input.Base, false, salt)
	if code != "" {
		return Result{}, code
	}
	head, code := scanSide(input.Head, false, salt)
	if code != "" {
		return Result{}, code
	}
	privacyCandidates := append(rawPrivacyCandidates(base), rawPrivacyCandidates(head)...)

	result := Result{
		ComparisonID: input.ComparisonID,
		BaseRevision: input.BaseRevision,
		HeadRevision: input.HeadRevision,
		ScannedFiles: []ScannedFile{},
		Introduced:   []Finding{},
		Unclassified: []UnclassifiedFinding{},
		Inline:       []InlineAllow{},
	}
	complete := input.BaseComplete && input.HeadComplete && input.ChangesComplete
	candidates := introducedMatches(base.matches, head.matches, input.HeadChanges)
	if complete {
		for _, match := range candidates {
			result.Introduced = append(result.Introduced, projectFinding(match))
		}
	} else {
		for _, match := range unclassifiedMatches(head.matches, input.HeadChanges, input.ChangesComplete) {
			finding := projectFinding(match)
			result.Unclassified = append(result.Unclassified, UnclassifiedFinding{
				Finding: finding,
				Reason:  "incomplete-snapshot",
			})
		}
	}

	marked := markedLines(input.Head.Files, input.HeadChanges, input.ChangesComplete)
	if hasInlineAllow(input.Base.Files) || hasInlineAllow(input.Head.Files) {
		baseOpen, errCode := scanSide(input.Base, true, salt)
		if errCode != "" {
			return Result{}, errCode
		}
		headOpen, errCode := scanSide(input.Head, true, salt)
		if errCode != "" {
			return Result{}, errCode
		}
		privacyCandidates = append(privacyCandidates, rawPrivacyCandidates(baseOpen)...)
		privacyCandidates = append(privacyCandidates, rawPrivacyCandidates(headOpen)...)
		if len(marked) > 0 {
			hidden := introducedMatches(baseOpen.matches, headOpen.matches, input.HeadChanges)
			for _, marker := range marked {
				inline := InlineAllow{
					Path:      marker.Path,
					FileIndex: marker.FileIndex,
					Line:      marker.Line,
					Exact:     complete,
					Matches:   []InlineMatch{},
				}
				if complete {
					for _, match := range hidden {
						if match.path == marker.Path && match.startLine <= marker.Line && marker.Line <= match.endLine {
							inline.Matches = append(inline.Matches, InlineMatch{
								Rule:        match.rule,
								Fingerprint: match.fingerprint,
								Masked:      match.masked,
							})
						}
					}
				}
				result.Inline = append(result.Inline, inline)
			}
		}
	}

	allowlistFiles := changedAllowlists(input.ChangedFiles)
	if len(allowlistFiles) > 0 {
		headBaseRules, errCode := scanSide(Side{
			Files:         input.Head.Files,
			Config:        input.Base.Config,
			ConfigPresent: input.Base.ConfigPresent,
			Ignore:        input.Base.Ignore,
			ConfigFiles:   input.Base.ConfigFiles,
		}, false, salt)
		if errCode != "" {
			return Result{}, errCode
		}
		privacyCandidates = append(privacyCandidates, rawPrivacyCandidates(headBaseRules)...)
		underBase := introducedMatches(base.matches, headBaseRules.matches, input.HeadChanges)
		introducedCounts := countMatches(candidates)
		leftOut := 0
		if complete {
			for _, match := range underBase {
				key := matchKey(match)
				if introducedCounts[key] > 0 {
					introducedCounts[key]--
				} else {
					leftOut++
				}
			}
		}
		allAdded := make([]string, 0)
		for _, file := range allowlistFiles {
			if file.Change == "removed" {
				continue
			}
			allAdded = append(allAdded, allowlistAdditions(
				file.Path,
				allowlistContent(input.Head, file.Path),
				input.HeadChanges[file.Path],
			)...)
		}
		totalAdded := len(allAdded)
		added := allAdded
		if len(added) > 20 {
			added = added[:20]
		}
		result.Allowlist = &AllowlistChange{
			Files:   allowlistFiles,
			Added:   added,
			Total:   totalAdded,
			LeftOut: leftOut,
			Exact:   complete,
		}
	}

	secrets := sortedUniqueSecrets(privacyCandidates)
	result.ComparisonID = sanitizeText(result.ComparisonID, secrets)
	result.BaseRevision = sanitizeText(result.BaseRevision, secrets)
	result.HeadRevision = sanitizeText(result.HeadRevision, secrets)
	result.ScannedFiles = scannedFiles(input, secrets)
	sanitizeResult(&result, secrets)
	return result, ""
}

func validRequest(input Request) bool {
	if input.ComparisonID == "" || input.BaseRevision == "" || input.HeadRevision == "" {
		return false
	}
	salt, err := hex.DecodeString(input.Salt)
	if err != nil || len(salt) != 32 {
		return false
	}
	for _, side := range []Side{input.Base, input.Head} {
		seen := make(map[string]struct{}, len(side.Files))
		for _, file := range side.Files {
			if !safePath(file.Path) {
				return false
			}
			if _, exists := seen[file.Path]; exists {
				return false
			}
			seen[file.Path] = struct{}{}
		}
		for name := range side.ConfigFiles {
			if !safePath(name) {
				return false
			}
		}
	}
	for _, file := range input.ChangedFiles {
		if !safePath(file.Path) || file.PreviousPath != "" && !safePath(file.PreviousPath) {
			return false
		}
	}
	for file, ranges := range input.HeadChanges {
		if !safePath(file) {
			return false
		}
		for _, interval := range ranges {
			if interval[0] < 1 || interval[1] < interval[0] {
				return false
			}
		}
	}
	return true
}

func introducedMatches(base, head []rawMatch, changed map[string][]LineRange) []rawMatch {
	availableAtBase := make(map[string]int)
	for _, match := range base {
		availableAtBase[matchKey(match)]++
	}

	unchanged := make([]rawMatch, 0)
	touched := make([]rawMatch, 0)
	for _, match := range head {
		if overlapsChange(changed, match.path, match.startLine, match.endLine) {
			touched = append(touched, match)
		} else {
			unchanged = append(unchanged, match)
		}
	}
	for _, match := range unchanged {
		availableAtBase[matchKey(match)]--
	}
	sort.Slice(touched, func(i, j int) bool {
		if touched[i].path != touched[j].path {
			return touched[i].path < touched[j].path
		}
		return touched[i].startLine < touched[j].startLine
	})

	introduced := make([]rawMatch, 0)
	for _, match := range touched {
		key := matchKey(match)
		if availableAtBase[key] > 0 {
			availableAtBase[key]--
		} else {
			introduced = append(introduced, match)
		}
	}
	return introduced
}

func unclassifiedMatches(matches []rawMatch, changed map[string][]LineRange, changesComplete bool) []rawMatch {
	out := make([]rawMatch, 0)
	for _, match := range matches {
		if !changesComplete || overlapsChange(changed, match.path, match.startLine, match.endLine) {
			out = append(out, match)
		}
	}
	return out
}

func overlapsChange(changed map[string][]LineRange, file string, start, end int) bool {
	for _, interval := range changed[file] {
		if start <= interval[1] && interval[0] <= end {
			return true
		}
	}
	return false
}

func matchKey(match rawMatch) string {
	return match.rule + "\x00" + match.span
}

func countMatches(matches []rawMatch) map[string]int {
	counts := make(map[string]int, len(matches))
	for _, match := range matches {
		counts[matchKey(match)]++
	}
	return counts
}

func markedLines(files []File, changes map[string][]LineRange, changesComplete bool) []InlineAllow {
	marked := make([]InlineAllow, 0)
	for fileIndex, file := range files {
		if !strings.Contains(file.Content, "gitleaks:allow") {
			continue
		}
		lines := strings.Split(file.Content, "\n")
		if !changesComplete {
			for number, line := range lines {
				if strings.Contains(line, "gitleaks:allow") {
					marked = append(marked, InlineAllow{Path: file.Path, FileIndex: fileIndex, Line: number + 1})
				}
			}
			continue
		}
		for _, interval := range changes[file.Path] {
			for number := interval[0]; number <= interval[1]; number++ {
				if number <= len(lines) && strings.Contains(lines[number-1], "gitleaks:allow") {
					marked = append(marked, InlineAllow{Path: file.Path, FileIndex: fileIndex, Line: number})
				}
			}
		}
	}
	sort.Slice(marked, func(i, j int) bool {
		if marked[i].Path != marked[j].Path {
			return marked[i].Path < marked[j].Path
		}
		return marked[i].Line < marked[j].Line
	})
	return marked
}

func hasInlineAllow(files []File) bool {
	for _, file := range files {
		if strings.Contains(file.Content, "gitleaks:allow") {
			return true
		}
	}
	return false
}

func changedAllowlists(files []ChangedFile) []AllowlistFile {
	out := make([]AllowlistFile, 0)
	for _, file := range files {
		if !isAllowlistPath(file.Path) && !isAllowlistPath(file.PreviousPath) {
			continue
		}
		change := "modified"
		if file.Status == "added" {
			change = "added"
		} else if file.Status == "removed" {
			change = "removed"
		}
		out = append(out, AllowlistFile{Path: file.Path, Change: change})
	}
	return out
}

func isAllowlistPath(file string) bool {
	return file == ".gitleaks.toml" || file == ".gitleaksignore"
}

func sourceFor(files []File, name string) string {
	for _, file := range files {
		if file.Path == name {
			return file.Content
		}
	}
	return ""
}

func allowlistContent(side Side, name string) string {
	switch name {
	case ".gitleaks.toml":
		return side.Config
	case ".gitleaksignore":
		return side.Ignore
	default:
		return sourceFor(side.Files, name)
	}
}

func allowlistAdditions(file, content string, ranges []LineRange) []string {
	lines := strings.Split(content, "\n")
	added := make([]string, 0)
	other := 0
	for _, interval := range ranges {
		for number := interval[0]; number <= interval[1] && number <= len(lines); number++ {
			line := strings.TrimSpace(strings.TrimSuffix(lines[number-1], "\r"))
			if line == "" || strings.HasPrefix(line, "#") {
				continue
			}
			if file == ".gitleaksignore" {
				added = append(added, utf16Slice(line, 120))
				continue
			}
			if id := tomlRuleID.FindStringSubmatch(line); len(id) == 2 {
				added = append(added, "rule "+id[1])
				continue
			}
			if tomlPaths.MatchString(line) {
				for _, value := range tomlValue.FindAllStringSubmatch(line, -1) {
					for _, part := range value[1:] {
						if part != "" {
							added = append(added, "path "+utf16Slice(part, 120))
							break
						}
					}
				}
				continue
			}
			if tomlRegexes.MatchString(line) || tomlStopwords.MatchString(line) {
				other++
			}
		}
	}
	if other > 0 {
		label := "lists"
		if other == 1 {
			label = "list"
		}
		added = append(added, strconv.Itoa(other)+" "+label+" of patterns or words")
	}
	return added
}

func utf16Slice(value string, limit int) string {
	var out strings.Builder
	units := 0
	for _, char := range value {
		width := len(utf16.Encode([]rune{char}))
		if units+width > limit {
			break
		}
		units += width
		out.WriteRune(char)
	}
	return out.String()
}

func rawPrivacyCandidates(scan rawScan) []string {
	spans := make([]string, 0, len(scan.privacyCandidates)+len(scan.matches))
	spans = append(spans, scan.privacyCandidates...)
	for _, match := range scan.matches {
		if match.span != "" {
			spans = append(spans, match.span)
		}
	}
	return spans
}

func scannedFiles(input Request, secrets []string) []ScannedFile {
	files := make([]ScannedFile, 0, len(input.Base.Files)+len(input.Head.Files))
	for index, file := range input.Base.Files {
		files = append(files, ScannedFile{Side: "base", Index: index, Path: sanitizeText(file.Path, secrets)})
	}
	for index, file := range input.Head.Files {
		files = append(files, ScannedFile{Side: "head", Index: index, Path: sanitizeText(file.Path, secrets)})
	}
	return files
}

func sanitizeResult(result *Result, secrets []string) {
	for index := range result.Introduced {
		result.Introduced[index] = sanitizeFinding(result.Introduced[index], secrets)
	}
	for index := range result.Unclassified {
		result.Unclassified[index].Finding = sanitizeFinding(result.Unclassified[index].Finding, secrets)
		result.Unclassified[index].Reason = sanitizeText(result.Unclassified[index].Reason, secrets)
	}
	for index := range result.Inline {
		result.Inline[index].Path = sanitizeText(result.Inline[index].Path, secrets)
		for matchIndex := range result.Inline[index].Matches {
			result.Inline[index].Matches[matchIndex].Rule = sanitizeText(result.Inline[index].Matches[matchIndex].Rule, secrets)
			result.Inline[index].Matches[matchIndex].Masked = sanitizeText(result.Inline[index].Matches[matchIndex].Masked, secrets)
		}
	}
	if result.Allowlist != nil {
		for index := range result.Allowlist.Files {
			result.Allowlist.Files[index].Path = sanitizeText(result.Allowlist.Files[index].Path, secrets)
		}
		for index := range result.Allowlist.Added {
			result.Allowlist.Added[index] = sanitizeText(result.Allowlist.Added[index], secrets)
		}
	}
}

func sanitizeFinding(finding Finding, secrets []string) Finding {
	finding.Rule = sanitizeText(finding.Rule, secrets)
	finding.Description = sanitizeText(finding.Description, secrets)
	finding.Location.Path = sanitizeText(finding.Location.Path, secrets)
	finding.Masked = sanitizeText(finding.Masked, secrets)
	return finding
}

func sanitizeText(value string, secrets []string) string {
	for _, secret := range secrets {
		if secret != "" {
			value = strings.ReplaceAll(value, secret, "[redacted]")
		}
	}
	return value
}

func projectFinding(match rawMatch) Finding {
	endCol := match.endCol
	if endCol < match.startCol+1 {
		endCol = match.startCol + 1
	}
	finding := Finding{
		Rule:        match.rule,
		Description: match.description,
		FileIndex:   match.fileIndex,
		Location: Location{
			Path:      match.path,
			StartLine: match.startLine,
			StartCol:  match.startCol,
			EndLine:   match.endLine,
			EndCol:    endCol,
		},
		Fingerprint: match.fingerprint,
		Masked:      match.masked,
	}
	if match.hasEntropy {
		finding.Entropy = &match.entropy
	}
	return finding
}

func sortedUniqueSecrets(values []string) []string {
	set := make(map[string]struct{}, len(values))
	for _, value := range values {
		if value != "" {
			set[value] = struct{}{}
		}
	}
	out := make([]string, 0, len(set))
	for value := range set {
		out = append(out, value)
	}
	sort.Slice(out, func(i, j int) bool { return len(out[i]) > len(out[j]) })
	return out
}
