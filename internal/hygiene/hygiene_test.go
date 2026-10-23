// Package hygiene holds repository guard checks that must pass in CI but run
// portably under `go test` (no shell dependency), so Windows developers get the
// same guarantees as Linux CI. It is a test-only package by design: there is no
// production code to import.
package hygiene

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"testing"
)

// repoRoot walks up from this file to the directory containing go.mod.
func repoRoot(t *testing.T) string {
	t.Helper()
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot locate source file")
	}
	dir := filepath.Dir(thisFile)
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Fatal("go.mod not found walking up from package")
		}
		dir = parent
	}
}

// secretLiteral matches a credential-shaped key assigned a quoted value of >=6
// chars. Values that are not quoted (typical of placeholders/booleans) do not
// match, so redaction key names in source are not false positives.
var secretLiteral = regexp.MustCompile(`(?i)(password|passwd|secret|api[_-]?key|access[_-]?key|private[_-]?key|authorization|credential|auth[_-]?token)\s*[:=]\s*["'` + "`" + `][^` + "`" + `"'` + "`" + `]{6,}["'` + "`" + `]`)

// bannedFileExtensions must never appear in tracked/committed content.
var bannedFileSuffixes = []string{".pem", ".key", ".p12", ".pfx", ".kdbx"}

// skipDirs are excluded from the content scan (third-party/generated/doc dirs).
func skipDir(name string) bool {
	switch name {
	case ".git", "node_modules", "web", "docs", "tools", "bin", "dist", "vendor":
		return true
	}
	return false
}

// isScannable reports whether a file's content should be checked for embedded
// secrets. Test files, examples, and lock/metadata files are excluded because
// they legitimately contain fake credential fixtures or generated hashes.
func isScannable(path string) bool {
	base := filepath.Base(path)
	if strings.HasSuffix(base, "_test.go") {
		return false
	}
	if base == ".env.example" || base == "go.sum" {
		return false
	}
	switch filepath.Ext(path) {
	case ".go", ".yaml", ".yml", ".json", ".toml", ".tf", ".sh", ".ps1":
		return true
	}
	return false
}

func TestNoBannedSecretFiles(t *testing.T) {
	root := repoRoot(t)
	var findings []string
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(root, p)
		if d.IsDir() {
			if skipDir(d.Name()) {
				return fs.SkipDir
			}
			return nil
		}
		if base := d.Name(); base == ".env" {
			findings = append(findings, rel+" (real .env must not be committed)")
			return nil
		}
		for _, s := range bannedFileSuffixes {
			if strings.HasSuffix(strings.ToLower(d.Name()), s) {
				findings = append(findings, rel+" (banned key material "+s+")")
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(findings) > 0 {
		t.Fatalf("banned secret files present:\n  %s", strings.Join(findings, "\n  "))
	}
}

func TestNoEmbeddedSecretLiterals(t *testing.T) {
	root := repoRoot(t)
	var findings []string
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if skipDir(d.Name()) {
				return fs.SkipDir
			}
			return nil
		}
		if !isScannable(p) {
			return nil
		}
		b, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(root, p)
		for i, line := range strings.Split(string(b), "\n") {
			if secretLiteral.MatchString(line) {
				findings = append(findings, fmt.Sprintf("%s:%d: %s", rel, i+1, strings.TrimSpace(line)))
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(findings) > 0 {
		t.Fatalf("possible embedded secrets in first-party files:\n  %s", strings.Join(findings, "\n  "))
	}
}

func TestEnvExampleHasOnlyFakeValues(t *testing.T) {
	root := repoRoot(t)
	example := filepath.Join(root, ".env.example")
	b, err := os.ReadFile(example)
	if err != nil {
		t.Fatalf(".env.example missing: %v", err)
	}
	// Every credential-bearing key in the example must carry an obvious marker.
	markers := []string{"change", "example", "fake", "local", "dev", "placeholder", "changeme"}
	for _, line := range strings.Split(string(b), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key := strings.ToUpper(line)
		if !strings.Contains(key, "PASSWORD") && !strings.Contains(key, "SECRET") && !strings.Contains(key, "TOKEN") {
			continue
		}
		val := strings.ToLower(line)
		found := false
		for _, m := range markers {
			if strings.Contains(val, m) {
				found = true
				break
			}
		}
		if !found {
			t.Errorf(".env.example credential line lacks an obvious fake marker: %q", line)
		}
	}
}
