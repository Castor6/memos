package wechatkf

import (
	"context"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/pkg/errors"

	"github.com/usememos/memos/internal/wechatarticle"
)

func articleCardURL(message Message) string {
	if stringValue(message["msgtype"]) != "link" {
		return ""
	}
	link, _ := object(message["link"])
	value := stringValue(link["url"])
	if !wechatarticle.IsArticleURL(value) {
		return ""
	}
	return value
}

func (p *Processor) articleFile(ctx context.Context, source string) (Media, error) {
	if p.convert == nil {
		return Media{}, &Failure{Stage: "转换正文", Reason: "文章转换组件不可用"}
	}
	result, err := p.convert(ctx, source)
	if err != nil {
		var articleError *wechatarticle.Error
		if errors.As(err, &articleError) {
			return Media{}, &Failure{Stage: "转换正文", Reason: articleError.Error()}
		}
		return Media{}, &Failure{Stage: "转换正文", Reason: "内部转换失败，请稍后重试"}
	}
	if strings.TrimSpace(result.Markdown) == "" {
		return Media{}, &Failure{Stage: "转换正文", Reason: "未取得可转换的文章正文"}
	}
	title := strings.Join(strings.Fields(result.Title), " ")
	if title == "" {
		title = "公众号文章"
	}
	// Bound metadata before including it in a downloadable document.
	if utf8.RuneCountInString(title) > 300 {
		title = string([]rune(title)[:300])
	}
	markdown := "# " + literal(title) + "\n\n"
	var metadata []string
	for _, value := range []string{result.Author, result.AccountName, result.PublishedAt, result.IPLocation} {
		value = strings.Join(strings.Fields(value), " ")
		if value != "" {
			metadata = append(metadata, literal(value))
		}
	}
	if len(metadata) > 0 {
		markdown += strings.Join(metadata, " · ") + "\n\n"
	}
	markdown += strings.TrimSpace(result.Markdown) + "\n"
	if len(markdown) > 1<<20 {
		return Media{}, &Failure{Stage: "转换正文", Reason: "转换后的文章超过 1 MB 限制"}
	}
	return Media{Data: []byte(markdown), Type: "text/markdown; charset=utf-8", Filename: articleFilename(title)}, nil
}

func articleFilename(title string) string {
	name := strings.Map(func(r rune) rune {
		if unicode.IsControl(r) || strings.ContainsRune("/\\:*?\"<>|", r) {
			return '_'
		}
		return r
	}, title)
	name = strings.Trim(name, " .")
	// Keep both the UTF-8 multipart filename and the extension within 240 bytes.
	for len(name) > 200 {
		_, size := utf8.DecodeLastRuneInString(name)
		name = name[:len(name)-size]
	}
	name = strings.Trim(name, " .")
	if name == "" {
		name = "公众号文章"
	}
	return name + ".md"
}
