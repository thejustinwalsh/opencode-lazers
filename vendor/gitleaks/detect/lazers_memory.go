package detect

import (
	"bufio"
	"io"
	"strings"

	"github.com/zricethezav/gitleaks/v8/logging"
)

// AddGitleaksIgnoreReader applies the same fingerprint parsing as AddGitleaksIgnore to captured
// side content, without opening a worktree path.
func (d *Detector) AddGitleaksIgnoreReader(source io.Reader) error {
	scanner := bufio.NewScanner(source)
	replacer := strings.NewReplacer("\\", "/")
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}

		parts := strings.Split(line, ":")
		switch len(parts) {
		case 3:
			parts[0] = replacer.Replace(parts[0])
		case 4:
			parts[1] = replacer.Replace(parts[1])
		default:
			logging.Warn().Str("fingerprint", line).Msg("Invalid .gitleaksignore entry")
		}
		d.gitleaksIgnore[strings.Join(parts, ":")] = struct{}{}
	}
	return scanner.Err()
}
