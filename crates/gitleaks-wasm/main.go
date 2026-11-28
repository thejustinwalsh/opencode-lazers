package main

import (
	"encoding/json"
	"io"
	"os"

	"github.com/rs/zerolog"
	"github.com/thejustinwalsh/opencode-lazers/crates/gitleaks-wasm/internal/scanner"
	"github.com/zricethezav/gitleaks/v8/logging"
)

const maxRequestBytes = 64 << 20

type request struct {
	Operation string          `json:"op"`
	Payload   scanner.Request `json:"payload"`
}

type response struct {
	OK     bool            `json:"ok"`
	Code   string          `json:"code,omitempty"`
	Result *scanner.Result `json:"result,omitempty"`
}

func main() {
	logging.Logger = zerolog.Nop()
	write(responseFor(readRequest()))
}

func readRequest() (input *scanner.Request) {
	defer func() {
		if recover() != nil {
			input = nil
		}
	}()

	raw, err := io.ReadAll(io.LimitReader(os.Stdin, maxRequestBytes+1))
	if err != nil || len(raw) > maxRequestBytes {
		return nil
	}
	var envelope request
	if json.Unmarshal(raw, &envelope) != nil || envelope.Operation != "gitleaks" {
		return nil
	}
	return &envelope.Payload
}

func responseFor(input *scanner.Request) (out response) {
	defer func() {
		if recover() != nil {
			out = response{Code: "detector-failed"}
		}
	}()

	if input == nil {
		return response{Code: "invalid-input"}
	}
	result, code := scanner.Scan(*input)
	if code != "" {
		return response{Code: code}
	}
	return response{OK: true, Result: &result}
}

func write(out response) {
	_ = json.NewEncoder(os.Stdout).Encode(out)
}
