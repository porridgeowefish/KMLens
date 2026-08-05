package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

var (
	appVersion          = "0.3.0"
	defaultUpdateSource = ""
)

const maxUpdateSize = 128 << 20

type UpdateManifest struct {
	Version string `json:"version"`
	URL     string `json:"url"`
	SHA256  string `json:"sha256"`
	Notes   string `json:"notes,omitempty"`
}

type UpdateStatus struct {
	State          string `json:"state"`
	CurrentVersion string `json:"currentVersion"`
	LatestVersion  string `json:"latestVersion,omitempty"`
	Notes          string `json:"notes,omitempty"`
	Message        string `json:"message,omitempty"`
}

type resolvedUpdate struct {
	manifest UpdateManifest
	source   string
}

func (a *App) AppVersion() string {
	return appVersion
}

func (a *App) CheckForUpdates(manual bool) UpdateStatus {
	source, err := updateSource()
	if err != nil {
		return UpdateStatus{State: "error", CurrentVersion: appVersion, Message: err.Error()}
	}
	if source == "" {
		return UpdateStatus{
			State:          "disabled",
			CurrentVersion: appVersion,
			Message:        "尚未配置更新发布地址",
		}
	}

	manifest, resolvedSource, err := loadManifest(source)
	if err != nil {
		status := UpdateStatus{State: "error", CurrentVersion: appVersion, Message: "检查更新失败：" + err.Error()}
		if !manual {
			status.Message = ""
		}
		return status
	}
	if !isNewerVersion(manifest.Version, appVersion) {
		a.updateMu.Lock()
		a.pendingUpdate = nil
		a.updateMu.Unlock()
		return UpdateStatus{
			State:          "current",
			CurrentVersion: appVersion,
			LatestVersion:  manifest.Version,
			Message:        "当前已是最新版本",
		}
	}

	a.updateMu.Lock()
	a.pendingUpdate = &resolvedUpdate{manifest: manifest, source: resolvedSource}
	a.updateMu.Unlock()
	status := UpdateStatus{
		State:          "available",
		CurrentVersion: appVersion,
		LatestVersion:  manifest.Version,
		Notes:          manifest.Notes,
		Message:        "发现新版本 " + manifest.Version,
	}
	if a.ctx != nil {
		wailsruntime.EventsEmit(a.ctx, "fieldnote:update-status", status)
	}
	return status
}

func (a *App) InstallUpdate() error {
	a.updateMu.Lock()
	update := a.pendingUpdate
	a.updateMu.Unlock()
	if update == nil {
		return errors.New("没有可安装的更新，请先检查更新")
	}

	tempDir, err := os.MkdirTemp("", "kmlens-update-*")
	if err != nil {
		return err
	}
	installerPath := filepath.Join(tempDir, "KMLens-Setup-"+safeVersion(update.manifest.Version)+".exe")
	if err := downloadUpdate(update.source, installerPath); err != nil {
		return err
	}
	if err := verifySHA256(installerPath, update.manifest.SHA256); err != nil {
		return err
	}
	if err := exec.Command(installerPath).Start(); err != nil {
		return fmt.Errorf("无法启动更新安装程序：%w", err)
	}
	go func() {
		time.Sleep(500 * time.Millisecond)
		if a.ctx != nil {
			wailsruntime.Quit(a.ctx)
		}
	}()
	return nil
}

func updateSource() (string, error) {
	if value := strings.TrimSpace(os.Getenv("KMLENS_UPDATE_URL")); value != "" {
		return validateUpdateSource(value)
	}
	if value := strings.TrimSpace(os.Getenv("FIELDNOTE_UPDATE_URL")); value != "" {
		return validateUpdateSource(value)
	}
	configDir, err := os.UserConfigDir()
	if err == nil {
		for _, appDir := range []string{"KMLens", "Fieldnote"} {
			data, readErr := os.ReadFile(filepath.Join(configDir, appDir, "update-source.txt"))
			if readErr == nil {
				if value := strings.TrimSpace(string(data)); value != "" {
					return validateUpdateSource(value)
				}
			}
		}
	}
	return validateUpdateSource(defaultUpdateSource)
}

func validateUpdateSource(source string) (string, error) {
	source = strings.TrimSpace(source)
	if source == "" {
		return "", nil
	}
	parsed, err := url.Parse(source)
	if err == nil && parsed.Scheme != "" {
		if parsed.Scheme != "https" && parsed.Scheme != "file" {
			return "", errors.New("更新地址只允许 HTTPS 或本地 file:// 路径")
		}
		return source, nil
	}
	if !filepath.IsAbs(source) {
		return "", errors.New("本地更新清单必须使用绝对路径")
	}
	return filepath.Clean(source), nil
}

func loadManifest(source string) (UpdateManifest, string, error) {
	data, err := readSource(source, 2<<20)
	if err != nil {
		return UpdateManifest{}, "", err
	}
	var manifest UpdateManifest
	if err := json.Unmarshal(data, &manifest); err != nil {
		return UpdateManifest{}, "", fmt.Errorf("更新清单格式无效：%w", err)
	}
	manifest.Version = strings.TrimSpace(strings.TrimPrefix(manifest.Version, "v"))
	manifest.SHA256 = strings.ToLower(strings.TrimSpace(manifest.SHA256))
	if manifest.Version == "" || manifest.URL == "" || len(manifest.SHA256) != 64 {
		return UpdateManifest{}, "", errors.New("更新清单缺少 version、url 或有效的 sha256")
	}
	if _, err := hex.DecodeString(manifest.SHA256); err != nil {
		return UpdateManifest{}, "", errors.New("更新清单中的 sha256 无效")
	}
	resolved, err := resolveUpdateURL(source, manifest.URL)
	if err != nil {
		return UpdateManifest{}, "", err
	}
	return manifest, resolved, nil
}

func readSource(source string, limit int64) ([]byte, error) {
	if parsed, err := url.Parse(source); err == nil && parsed.Scheme == "https" {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, source, nil)
		if err != nil {
			return nil, err
		}
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			return nil, err
		}
		defer response.Body.Close()
		if response.StatusCode != http.StatusOK {
			return nil, fmt.Errorf("更新服务器返回 HTTP %d", response.StatusCode)
		}
		return io.ReadAll(io.LimitReader(response.Body, limit))
	}
	path := source
	if parsed, err := url.Parse(source); err == nil && parsed.Scheme == "file" {
		path = fileURLPath(parsed)
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	return io.ReadAll(io.LimitReader(file, limit))
}

func resolveUpdateURL(manifestSource, updateURL string) (string, error) {
	parsedUpdate, err := url.Parse(updateURL)
	if err == nil && parsedUpdate.Scheme != "" {
		return validateUpdateSource(updateURL)
	}
	if parsedManifest, parseErr := url.Parse(manifestSource); parseErr == nil && parsedManifest.Scheme == "https" {
		resolved := parsedManifest.ResolveReference(parsedUpdate)
		if resolved.Scheme != "https" {
			return "", errors.New("远程安装包必须使用 HTTPS")
		}
		return resolved.String(), nil
	}
	manifestPath := manifestSource
	if parsedManifest, parseErr := url.Parse(manifestSource); parseErr == nil && parsedManifest.Scheme == "file" {
		manifestPath = fileURLPath(parsedManifest)
	}
	return filepath.Join(filepath.Dir(manifestPath), filepath.FromSlash(updateURL)), nil
}

func downloadUpdate(source, destination string) error {
	if parsed, err := url.Parse(source); err == nil && parsed.Scheme == "https" {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
		defer cancel()
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, source, nil)
		if err != nil {
			return err
		}
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			return err
		}
		defer response.Body.Close()
		if response.StatusCode != http.StatusOK {
			return fmt.Errorf("下载安装包失败：HTTP %d", response.StatusCode)
		}
		if response.ContentLength > maxUpdateSize {
			return errors.New("安装包超过 128 MB 安全上限")
		}
		return copyLimited(response.Body, destination)
	}
	path := source
	if parsed, err := url.Parse(source); err == nil && parsed.Scheme == "file" {
		path = fileURLPath(parsed)
	}
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	return copyLimited(file, destination)
}

func copyLimited(source io.Reader, destination string) error {
	file, err := os.OpenFile(destination, os.O_CREATE|os.O_WRONLY|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	defer file.Close()
	written, err := io.Copy(file, io.LimitReader(source, maxUpdateSize+1))
	if err != nil {
		return err
	}
	if written > maxUpdateSize {
		return errors.New("安装包超过 128 MB 安全上限")
	}
	return file.Sync()
}

func verifySHA256(path, expected string) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return err
	}
	actual := hex.EncodeToString(hash.Sum(nil))
	if !strings.EqualFold(actual, expected) {
		return fmt.Errorf("安装包校验失败（期望 %s，实际 %s）", expected, actual)
	}
	return nil
}

func isNewerVersion(candidate, current string) bool {
	a, okA := versionParts(candidate)
	b, okB := versionParts(current)
	if !okA || !okB {
		return candidate != current
	}
	for index := 0; index < 3; index++ {
		if a[index] != b[index] {
			return a[index] > b[index]
		}
	}
	return false
}

func versionParts(value string) ([3]int, bool) {
	var result [3]int
	parts := strings.Split(strings.TrimPrefix(strings.TrimSpace(value), "v"), ".")
	if len(parts) < 2 || len(parts) > 3 {
		return result, false
	}
	for index, part := range parts {
		numeric := strings.SplitN(part, "-", 2)[0]
		parsed, err := strconv.Atoi(numeric)
		if err != nil || parsed < 0 {
			return result, false
		}
		result[index] = parsed
	}
	return result, true
}

func safeVersion(value string) string {
	var builder strings.Builder
	for _, character := range value {
		if (character >= '0' && character <= '9') || character == '.' || character == '-' {
			builder.WriteRune(character)
		}
	}
	if builder.Len() == 0 {
		return "update"
	}
	return builder.String()
}

func fileURLPath(parsed *url.URL) string {
	path := filepath.FromSlash(parsed.Path)
	if parsed.Host != "" {
		if len(parsed.Host) == 2 && parsed.Host[1] == ':' {
			return parsed.Host + path
		}
		return `\\` + parsed.Host + path
	}
	trimmed := strings.TrimLeft(path, `\`)
	if len(trimmed) >= 2 && trimmed[1] == ':' {
		return trimmed
	}
	return path
}
