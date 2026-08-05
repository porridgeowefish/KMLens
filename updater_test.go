package main

import (
	"crypto/sha256"
	"encoding/hex"
	"net/url"
	"os"
	"path/filepath"
	"testing"
)

func TestVersionComparison(t *testing.T) {
	tests := []struct {
		candidate string
		current   string
		want      bool
	}{
		{"0.2.1", "0.2.0", true},
		{"0.3.0", "0.2.9", true},
		{"1.0.0", "0.99.99", true},
		{"0.2.0", "0.2.0", false},
		{"0.1.9", "0.2.0", false},
	}
	for _, test := range tests {
		if got := isNewerVersion(test.candidate, test.current); got != test.want {
			t.Fatalf("isNewerVersion(%q, %q) = %v, want %v", test.candidate, test.current, got, test.want)
		}
	}
}

func TestLocalManifestAndChecksum(t *testing.T) {
	tempDir := t.TempDir()
	installer := filepath.Join(tempDir, "Fieldnote-Setup-9.9.9.exe")
	payload := []byte("fieldnote updater fixture")
	if err := os.WriteFile(installer, payload, 0o600); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(payload)
	expected := hex.EncodeToString(sum[:])
	manifestPath := filepath.Join(tempDir, "latest.json")
	manifestJSON := []byte(`{"version":"9.9.9","url":"Fieldnote-Setup-9.9.9.exe","sha256":"` + expected + `"}`)
	if err := os.WriteFile(manifestPath, manifestJSON, 0o600); err != nil {
		t.Fatal(err)
	}

	manifest, resolved, err := loadManifest(manifestPath)
	if err != nil {
		t.Fatal(err)
	}
	if manifest.Version != "9.9.9" || resolved != installer {
		t.Fatalf("unexpected manifest result: %#v, %q", manifest, resolved)
	}
	if err := verifySHA256(resolved, expected); err != nil {
		t.Fatal(err)
	}

	sourceURL := (&url.URL{Scheme: "file", Path: filepath.ToSlash(manifestPath)}).String()
	t.Setenv("FIELDNOTE_UPDATE_URL", sourceURL)
	app := NewApp(nil)
	status := app.CheckForUpdates(true)
	if status.State != "available" || status.LatestVersion != "9.9.9" {
		t.Fatalf("unexpected update status: %#v", status)
	}
}
