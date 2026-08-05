package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/wailsapp/wails/v2/pkg/options"
	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

type GeoFile struct {
	Name string `json:"name"`
	Size int64  `json:"size"`
	Text string `json:"text"`
}

type App struct {
	ctx          context.Context
	pendingPaths []string
	pendingMu    sync.Mutex

	updateMu      sync.Mutex
	pendingUpdate *resolvedUpdate
}

func NewApp(args []string) *App {
	return &App{pendingPaths: geoFilePaths(args)}
}

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
}

func (a *App) domReady(ctx context.Context) {
	a.ctx = ctx
}

func (a *App) secondInstance(data options.SecondInstanceData) {
	paths := geoFilePaths(data.Args)
	if len(paths) > 0 {
		files := readGeoFiles(paths)
		if len(files) > 0 && a.ctx != nil {
			wailsruntime.EventsEmit(a.ctx, "fieldnote:open-files", files)
		}
	}
	if a.ctx != nil {
		wailsruntime.WindowUnminimise(a.ctx)
		wailsruntime.WindowShow(a.ctx)
	}
}

func (a *App) PickGeoFiles() ([]GeoFile, error) {
	paths, err := wailsruntime.OpenMultipleFilesDialog(a.ctx, wailsruntime.OpenDialogOptions{
		Title: "打开 KML / GPX 文件",
		Filters: []wailsruntime.FileFilter{
			{DisplayName: "地理文件 (*.kml;*.gpx)", Pattern: "*.kml;*.gpx"},
			{DisplayName: "KML 文件 (*.kml)", Pattern: "*.kml"},
			{DisplayName: "GPX 文件 (*.gpx)", Pattern: "*.gpx"},
		},
	})
	if err != nil {
		return nil, err
	}
	return readGeoFiles(paths), nil
}

func (a *App) ConsumePendingFiles() []GeoFile {
	a.pendingMu.Lock()
	paths := append([]string(nil), a.pendingPaths...)
	a.pendingPaths = nil
	a.pendingMu.Unlock()
	return readGeoFiles(paths)
}

func geoFilePaths(args []string) []string {
	paths := make([]string, 0, len(args))
	seen := make(map[string]struct{})
	for _, arg := range args {
		path := strings.Trim(strings.TrimSpace(arg), "\"")
		ext := strings.ToLower(filepath.Ext(path))
		if ext != ".kml" && ext != ".gpx" {
			continue
		}
		absolute, err := filepath.Abs(path)
		if err != nil {
			continue
		}
		info, err := os.Stat(absolute)
		if err != nil || !info.Mode().IsRegular() {
			continue
		}
		key := strings.ToLower(absolute)
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		paths = append(paths, absolute)
	}
	return paths
}

func readGeoFiles(paths []string) []GeoFile {
	files := make([]GeoFile, 0, len(paths))
	for _, path := range geoFilePaths(paths) {
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		files = append(files, GeoFile{
			Name: filepath.Base(path),
			Size: int64(len(data)),
			Text: string(data),
		})
	}
	return files
}
