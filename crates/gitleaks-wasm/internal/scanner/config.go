package scanner

import (
	"errors"
	"path"
	"strings"

	"github.com/spf13/afero"
	"github.com/spf13/viper"
	"github.com/zricethezav/gitleaks/v8/config"
	"github.com/zricethezav/gitleaks/v8/detect"
)

var errConfig = errors.New("invalid captured gitleaks configuration")

func detectorFor(side Side) (*detect.Detector, error) {
	config.ResetMemoryConfigState()
	filesystem := afero.NewMemMapFs()
	for name, content := range side.ConfigFiles {
		clean := path.Clean(name)
		if !safePath(name) || clean != name || strings.HasPrefix(clean, "../") {
			return nil, errConfig
		}
		if err := filesystem.MkdirAll(path.Dir(clean), 0o755); err != nil {
			return nil, errConfig
		}
		if err := afero.WriteFile(filesystem, clean, []byte(content), 0o644); err != nil {
			return nil, errConfig
		}
	}

	viper.SetFs(filesystem)
	viper.SetConfigType("toml")
	content := side.Config
	if !side.ConfigPresent {
		content = config.DefaultConfig
	}
	if err := viper.ReadConfig(strings.NewReader(content)); err != nil {
		return nil, errConfig
	}

	var parsed config.ViperConfig
	if err := viper.Unmarshal(&parsed); err != nil {
		return nil, errConfig
	}
	translated, err := parsed.Translate()
	if err != nil {
		return nil, errConfig
	}
	translated.Path = ".gitleaks.toml"

	detector := detect.NewDetector(translated)
	detector.MaxDecodeDepth = 5
	detector.MaxArchiveDepth = 0
	detector.MaxTargetMegaBytes = 0
	detector.Redact = 0
	if err := detector.AddGitleaksIgnoreReader(strings.NewReader(side.Ignore)); err != nil {
		return nil, errConfig
	}
	return detector, nil
}
