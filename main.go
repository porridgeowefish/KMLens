package main

import (
	"embed"
	"os"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/windows"
)

//go:embed all:desktop-dist
var assets embed.FS

func main() {
	app := NewApp(os.Args[1:])

	err := wails.Run(&options.App{
		Title:            "KMLens",
		Width:            1360,
		Height:           860,
		MinWidth:         900,
		MinHeight:        620,
		BackgroundColour: &options.RGBA{R: 247, G: 244, B: 236, A: 255},
		AssetServer: &assetserver.Options{
			Assets: assets,
		},
		OnStartup:  app.startup,
		OnDomReady: app.domReady,
		Bind: []interface{}{
			app,
		},
		SingleInstanceLock: &options.SingleInstanceLock{
			UniqueId:               "io.github.porridgeowefish.kmlens",
			OnSecondInstanceLaunch: app.secondInstance,
		},
		Windows: &windows.Options{
			Theme:                windows.Light,
			IsZoomControlEnabled: false,
			ZoomFactor:           1,
		},
	})
	if err != nil {
		println("KMLens startup error:", err.Error())
	}
}
