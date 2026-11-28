package config

import "github.com/spf13/viper"

// ResetMemoryConfigState isolates sequential snapshot scans from Gitleaks' global config state.
func ResetMemoryConfigState() {
	extendDepth = 0
	viper.Reset()
}
