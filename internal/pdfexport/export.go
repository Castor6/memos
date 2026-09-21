// Package pdfexport prepares complete memo documents and invokes the PDF renderer.
package pdfexport

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/png"
	"io"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/disintegration/imaging"
	"github.com/pkg/errors"
	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/extension"
	goldhtml "github.com/yuin/goldmark/renderer/html"
	"golang.org/x/net/html"
	"golang.org/x/net/html/atom"

	// Register common attachment image decoders.
	_ "golang.org/x/image/webp"
)

// MaxImageBytes limits each source image before decoding.
const MaxImageBytes = 16 << 20
const maxDocumentBytes = 32 << 20

// ReadImage reads a bounded attachment or remote response.
func ReadImage(reader io.Reader) ([]byte, error) {
	data, err := io.ReadAll(io.LimitReader(reader, MaxImageBytes+1))
	if err != nil {
		return nil, err
	}
	if len(data) > MaxImageBytes {
		return nil, errors.New("图片超过 16 MiB，无法导出")
	}
	return data, nil
}

// Prepare renders Markdown and embeds all body images without fetching anything itself.
func Prepare(content, origin string, load func(string) ([]byte, error)) (string, error) {
	var rendered bytes.Buffer
	md := goldmark.New(goldmark.WithExtensions(extension.GFM), goldmark.WithRendererOptions(goldhtml.WithHardWraps()))
	if err := md.Convert([]byte(content), &rendered); err != nil {
		return "", err
	}
	doc, err := html.Parse(&rendered)
	if err != nil {
		return "", err
	}
	base, _ := url.Parse(origin)
	images := map[string]string{}
	imageWidths := map[string]int{}
	total := 0
	var walk func(*html.Node) error
	walk = func(node *html.Node) error {
		if node.Type == html.ElementNode && node.Data == "img" {
			src, title, alt := "", "", ""
			for _, a := range node.Attr {
				switch a.Key {
				case "src":
					src = a.Val
				case "title":
					title = a.Val
				case "alt":
					alt = a.Val
				default:
				}
			}
			if title == "memos:reference" || (strings.HasPrefix(title, "memos:file:") && !strings.HasPrefix(title, "memos:file:image/")) {
				node.Data = "a"
				node.DataAtom = atom.A
				node.Attr = []html.Attribute{{Key: "href", Val: src}}
				node.AppendChild(&html.Node{Type: html.TextNode, Data: alt})
			} else {
				value, ok := images[src]
				if !ok {
					data, err := load(src)
					if err != nil {
						return errors.Wrap(err, "读取正文图片失败")
					}
					config, _, err := image.DecodeConfig(bytes.NewReader(data))
					if err != nil {
						return errors.New("图片格式无法解码")
					}
					if config.Width <= 0 || config.Height <= 0 || config.Width > 50_000_000/config.Height {
						return errors.New("图片像素过大")
					}
					decoded, err := imaging.Decode(bytes.NewReader(data), imaging.AutoOrientation(true))
					if err != nil {
						return errors.Wrap(err, "解码正文图片")
					}
					if decoded.Bounds().Dx() > 4096 || decoded.Bounds().Dy() > 4096 {
						decoded = imaging.Fit(decoded, 4096, 4096, imaging.Lanczos)
					}
					var pngData bytes.Buffer
					if err := png.Encode(&pngData, decoded); err != nil {
						return errors.Wrap(err, "转换正文图片")
					}
					total += pngData.Len()
					if total > maxDocumentBytes {
						return errors.New("正文图片合计超过 32 MiB")
					}
					value = "data:image/png;base64," + base64.StdEncoding.EncodeToString(pngData.Bytes())
					images[src] = value
					imageWidths[src] = decoded.Bounds().Dx()
				}
				node.Attr = append(node.Attr, html.Attribute{Key: "width", Val: strconv.Itoa(imageWidths[src])})
				for i := range node.Attr {
					if node.Attr[i].Key == "src" {
						node.Attr[i].Val = value
					}
				}
			}
		}
		if node.Type == html.ElementNode && node.Data == "a" {
			for i, a := range node.Attr {
				if a.Key != "href" {
					continue
				}
				target, err := url.Parse(a.Val)
				if err != nil {
					node.Attr[i].Val = ""
					continue
				}
				if base != nil {
					target = base.ResolveReference(target)
				}
				if target.Scheme == "http" || target.Scheme == "https" || target.Scheme == "mailto" || target.Scheme == "" {
					node.Attr[i].Val = target.String()
				} else {
					node.Attr[i].Val = ""
				}
			}
		}
		for child := node.FirstChild; child != nil; child = child.NextSibling {
			if err := walk(child); err != nil {
				return err
			}
		}
		return nil
	}
	if err := walk(doc); err != nil {
		return "", err
	}
	var output bytes.Buffer
	if err := html.Render(&output, doc); err != nil {
		return "", err
	}
	if output.Len() > 48<<20 {
		return "", errors.New("导出内容过大")
	}
	return output.String(), nil
}

// Render starts a short-lived Node process; no shell or user-provided paths are used.
func Render(ctx context.Context, html, title string) ([]byte, error) {
	script := os.Getenv("MEMOS_PDF_RENDERER")
	if script == "" {
		executable, err := os.Executable()
		if err != nil {
			return nil, err
		}
		script = filepath.Join(filepath.Dir(executable), "pdf", "render.mjs")
		if _, err := os.Stat(script); err != nil {
			script = filepath.Join("scripts", "pdf", "render.mjs")
		}
	}
	if _, err := os.Stat(script); err != nil {
		return nil, errors.New("服务器未安装 PDF 排版组件")
	}
	input, err := json.Marshal(struct {
		HTML  string `json:"html"`
		Title string `json:"title"`
	}{html, title})
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, "node", "--max-old-space-size=384", script)
	command.Stdin = bytes.NewReader(input)
	output, err := command.Output()
	if ctx.Err() != nil {
		return nil, errors.New("PDF 生成超时或已取消，请重试")
	}
	if err != nil {
		return nil, errors.Wrap(err, "服务器 PDF 生成失败")
	}
	if !bytes.HasPrefix(output, []byte("%PDF-")) {
		return nil, errors.New("服务器返回了无效 PDF")
	}
	return output, nil
}
