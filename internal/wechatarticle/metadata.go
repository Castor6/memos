package wechatarticle

import (
	"encoding/json"
	stdhtml "html"
	"strconv"
	"strings"
	"time"
	"unicode"

	"golang.org/x/net/html"
)

// articleMetadata reads only article header nodes and literal top-level page data.
func articleMetadata(nodes []*html.Node, content *html.Node) Result {
	var result Result
	values := map[string]string{}
	ip := map[string]string{}
	for _, node := range nodes {
		inside := false
		for parent := node; parent != nil; parent = parent.Parent {
			if parent == content {
				inside = true
				break
			}
		}
		if inside || node.Type != html.ElementNode {
			continue
		}
		switch attribute(node, "id") {
		case "js_author_name_text":
			result.Author = plainText(node)
		case "js_author_name":
			if result.Author == "" {
				result.Author = plainText(node)
			}
		case "js_name":
			result.AccountName = plainText(node)
		case "publish_time":
			result.PublishedAt = normalizePublishedAt(plainText(node))
		}
		if node.Data == "script" {
			metadataScript(textContent(node), values, ip)
		}
	}
	if result.Author == "" {
		result.Author = values["author"]
	}
	if result.AccountName == "" {
		result.AccountName = values["nickname"]
	}
	if result.PublishedAt == "" {
		result.PublishedAt = normalizePublishedAt(values["createTime"])
	}
	if result.PublishedAt == "" {
		if seconds, err := strconv.ParseInt(values["ct"], 10, 64); err == nil && seconds > 0 && seconds <= 253402271999 {
			result.PublishedAt = time.Unix(seconds, 0).In(time.FixedZone("CST", 8*60*60)).Format("2006年01月02日 15:04")
		}
	}
	if values["show_ip_wording"] == "1" || values["show_ip_wording"] == "true" {
		result.IPLocation = ip["countryName"]
		if ip["countryId"] == "156" || ip["countryName"] == "中国" {
			result.IPLocation = ip["provinceName"]
		}
	}
	result.Author = cleanMetadata(result.Author)
	result.AccountName = cleanMetadata(result.AccountName)
	result.IPLocation = cleanMetadata(result.IPLocation)
	return result
}

func normalizePublishedAt(value string) string {
	for _, layout := range []string{"2006-01-02 15:04", "2006-01-02 15:04:05", "2006年1月2日 15:04", "2006-01-02", "2006年1月2日"} {
		if parsed, err := time.Parse(layout, strings.TrimSpace(value)); err == nil {
			if strings.Contains(layout, "15:04") {
				return parsed.Format("2006年01月02日 15:04")
			}
			return parsed.Format("2006年01月02日")
		}
	}
	return ""
}

func metadataScript(source string, values, ip map[string]string) {
	var tokens []string
	for _, token := range scriptTokens.FindAllString(source, -1) {
		if !strings.HasPrefix(token, "//") && !strings.HasPrefix(token, "/*") {
			tokens = append(tokens, token)
		}
	}
	depth := 0
	for i, token := range tokens {
		if depth == 0 && i+2 < len(tokens) && tokens[i+1] == "=" && i > 0 &&
			(tokens[i-1] == "var" || tokens[i-1] == "let" || tokens[i-1] == "const" ||
				(i >= 2 && tokens[i-2] == "window" && tokens[i-1] == ".")) {
			switch token {
			case "author", "nickname", "createTime", "ct", "show_ip_wording":
				value, ok := metadataLiteral(tokens[i+2])
				end := i + 3
				if token == "show_ip_wording" && end+1 < len(tokens) && tokens[end] == "*" && tokens[end+1] == "1" {
					end += 2
				}
				if ok && (end == len(tokens) || tokens[end] == ";") {
					values[token] = value
				}
			case "ip_wording":
				if object, ok := metadataObject(tokens[i+2:]); ok {
					clear(ip)
					for key, value := range object {
						ip[key] = value
					}
				}
			}
		}
		switch token {
		case "{", "[", "(":
			depth++
		case "}", "]", ")":
			depth--
		}
	}
}

func metadataObject(tokens []string) (map[string]string, bool) {
	result := map[string]string{}
	if len(tokens) == 0 || tokens[0] != "{" {
		return nil, false
	}
	for i := 1; i < len(tokens); {
		if tokens[i] == "}" {
			return result, i+1 == len(tokens) || tokens[i+1] == ";"
		}
		if i+2 >= len(tokens) || tokens[i+1] != ":" {
			return nil, false
		}
		key := tokens[i]
		if strings.HasPrefix(key, "'") || strings.HasPrefix(key, "\"") {
			key, _ = metadataLiteral(key)
		}
		value, ok := metadataLiteral(tokens[i+2])
		if !ok {
			return nil, false
		}
		result[key] = value
		i += 3
		if i < len(tokens) && tokens[i] == "," {
			i++
		} else if i >= len(tokens) || tokens[i] != "}" {
			return nil, false
		}
	}
	return nil, false
}

// metadataLiteral decodes data without evaluating JavaScript expressions.
func metadataLiteral(token string) (string, bool) {
	if token == "true" || token == "false" {
		return token, true
	}
	if _, err := strconv.ParseInt(token, 10, 64); err == nil {
		return token, true
	}
	if len(token) < 2 || (token[0] != '\'' && token[0] != '"') || token[len(token)-1] != token[0] {
		return "", false
	}
	var encoded strings.Builder
	encoded.WriteByte('"')
	for i := 1; i < len(token)-1; i++ {
		c := token[i]
		if c == '\\' {
			i++
			if i >= len(token)-1 {
				return "", false
			}
			if token[i] == '\'' {
				encoded.WriteByte('\'')
			} else {
				encoded.WriteByte('\\')
				encoded.WriteByte(token[i])
			}
		} else if c == '"' {
			encoded.WriteString(`\"`)
		} else {
			encoded.WriteByte(c)
		}
	}
	encoded.WriteByte('"')
	var value string
	if json.Unmarshal([]byte(encoded.String()), &value) != nil {
		return "", false
	}
	return strings.Join(strings.Fields(stdhtml.UnescapeString(value)), " "), true
}

func cleanMetadata(value string) string {
	value = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return ' '
		}
		return r
	}, value)
	chars := []rune(strings.Join(strings.Fields(value), " "))
	if len(chars) > 256 {
		chars = chars[:256]
	}
	return string(chars)
}
