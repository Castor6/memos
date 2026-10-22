package wechatarticle

import (
	"bytes"
	"regexp"
	"strings"
	"unicode"

	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/extension"
	"github.com/yuin/goldmark/text"
)

var escapedReferenceNumber = regexp.MustCompile(`\\\[[0-9]+\]`)

// readableReferenceNumbers removes redundant escapes from plain numbered citations.
// Code, link labels, and syntax-sensitive brackets retain their original spelling.
func readableReferenceNumbers(source []byte) []byte {
	if !escapedReferenceNumber.Match(source) {
		return source
	}
	parser := goldmark.New(goldmark.WithExtensions(extension.GFM))
	doc := parser.Parser().Parse(text.NewReader(source))
	var segments []text.Segment
	_ = ast.Walk(doc, func(node ast.Node, entering bool) (ast.WalkStatus, error) {
		if !entering {
			return ast.WalkContinue, nil
		}
		switch node.Kind() {
		case ast.KindCodeSpan, ast.KindLink, ast.KindImage:
			return ast.WalkSkipChildren, nil
		default:
		}
		part, ok := node.(*ast.Text)
		if !ok {
			return ast.WalkContinue, nil
		}
		if len(segments) > 0 && segments[len(segments)-1].Stop == part.Segment.Start {
			segments[len(segments)-1].Stop = part.Segment.Stop
		} else {
			segments = append(segments, part.Segment)
		}
		return ast.WalkContinue, nil
	})
	var positions []int
	for _, segment := range segments {
		for _, match := range escapedReferenceNumber.FindAllIndex(segment.Value(source), -1) {
			start, end := segment.Start+match[0], segment.Start+match[1]
			if start > 0 && strings.ContainsRune(`\!]`, rune(source[start-1])) {
				continue
			}
			tail := bytes.TrimLeftFunc(source[end:], unicode.IsSpace)
			if bytes.HasPrefix(tail, []byte(`\[`)) || (len(tail) > 0 && strings.ContainsRune("[(:", rune(tail[0]))) {
				continue
			}
			positions = append(positions, start)
		}
	}
	if len(positions) == 0 {
		return source
	}
	var candidate bytes.Buffer
	last := 0
	for _, position := range positions {
		candidate.Write(source[last:position])
		last = position + 1
	}
	candidate.Write(source[last:])
	// Keep the original if removing escapes changes how the document renders,
	// including reference definitions or syntax spanning separate text nodes.
	var before, after bytes.Buffer
	if err := parser.Renderer().Render(&before, source, doc); err != nil {
		return source
	}
	if err := parser.Convert(candidate.Bytes(), &after); err != nil || !bytes.Equal(before.Bytes(), after.Bytes()) {
		return source
	}
	return candidate.Bytes()
}
