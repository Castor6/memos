// Package linkmetadata extracts previewable links from memo content.
package linkmetadata

import (
	"strings"

	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/extension"
	"github.com/yuin/goldmark/text"
)

// URLs returns standalone HTTP links matching the frontend card rules.
func URLs(content string) []string {
	source := []byte(content)
	doc := goldmark.New(goldmark.WithExtensions(extension.GFM)).Parser().Parse(text.NewReader(source))
	seen := map[string]bool{}
	var urls []string
	for paragraph := doc.FirstChild(); paragraph != nil; paragraph = paragraph.NextSibling() {
		if paragraph.Kind() != ast.KindParagraph {
			continue
		}
		var value string
		valid := true
		for node := paragraph.FirstChild(); node != nil; node = node.NextSibling() {
			switch link := node.(type) {
			case *ast.Text:
				if strings.TrimSpace(string(link.Segment.Value(source))) != "" {
					valid = false
				}
			case *ast.Link:
				if value != "" {
					valid = false
				}
				value = string(link.Destination)
				label, ok := link.FirstChild().(*ast.Text)
				if !ok || label.NextSibling() != nil || string(label.Value(source)) != value {
					valid = false
				}
			case *ast.AutoLink:
				if value != "" {
					valid = false
				}
				value = string(link.URL(source))
			default:
				valid = false
			}
		}
		if valid && (strings.HasPrefix(value, "https://") || strings.HasPrefix(value, "http://")) && !seen[value] {
			seen[value] = true
			urls = append(urls, value)
		}
	}
	return urls
}
