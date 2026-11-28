package scanner

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"regexp"
	"strings"
	"unicode"
)

var pemSecretHeader = regexp.MustCompile(`^-----BEGIN [A-Z0-9 ]{1,40}-----$`)

func fingerprint(key []byte, rule, secret string) string {
	hash := hmac.New(sha256.New, key)
	_, _ = hash.Write([]byte(rule))
	_, _ = hash.Write([]byte{0})
	_, _ = hash.Write([]byte(secret))
	return hex.EncodeToString(hash.Sum(nil)[:16])
}

func maskSecret(value string) string {
	first := strings.Split(value, "\n")[0]
	var clean strings.Builder
	for _, character := range first {
		if !isUnicodeCategoryC(character) {
			clean.WriteRune(character)
		}
	}
	line := strings.TrimSpace(clean.String())
	if strings.Contains(value, "\n") && pemSecretHeader.MatchString(line) {
		return line + " ********"
	}
	characters := []rune(line)
	shown := len(characters) / 6
	if shown > 4 {
		shown = 4
	}
	if shown == 0 {
		return "********"
	}
	return string(characters[:shown]) + "********" + string(characters[len(characters)-shown:])
}

func isUnicodeCategoryC(character rune) bool {
	for _, category := range []string{"Cc", "Cf", "Cs", "Co", "Cn"} {
		if unicode.Is(unicode.Categories[category], character) {
			return true
		}
	}
	return false
}
