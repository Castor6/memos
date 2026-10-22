package wechatarticle

import (
	"regexp"
	"strings"
)

// Tokens keep quoted strings and comments intact; no page JavaScript is executed.
var scriptTokens = regexp.MustCompile(`(?s)'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|` + "`(?:\\\\.|[^`\\\\])*`" + `|//[^\r\n]*|/\*.*?\*/|[a-zA-Z_$][\w$]*|\d+|[^\s]`)

func paidScript(source string) bool {
	if !strings.Contains(source, "is_pay_subscribe") {
		return false
	}
	var tokens []string
	for _, token := range scriptTokens.FindAllString(source, -1) {
		if !strings.HasPrefix(token, "//") && !strings.HasPrefix(token, "/*") {
			tokens = append(tokens, token)
		}
	}
	depth, cgiDepth := 0, -1
	for i, token := range tokens {
		if token == "{" || token == "[" || token == "(" {
			depth++
			if token == "{" && i >= 4 && strings.Join(tokens[i-4:i], " ") == "window . cgiDataNew =" {
				cgiDepth = depth
			}
		} else if token == "}" || token == "]" || token == ")" {
			if depth == cgiDepth {
				cgiDepth = -1
			}
			depth--
		}
		if strings.Trim(token, "\"'") != "is_pay_subscribe" || i+2 >= len(tokens) {
			continue
		}
		global := depth == 0 && token == "is_pay_subscribe" && i > 0 &&
			(tokens[i-1] == "var" || tokens[i-1] == "let" || tokens[i-1] == "const" || (i >= 2 && tokens[i-2] == "window" && tokens[i-1] == "."))
		field := cgiDepth >= 0 && depth == cgiDepth && i > 0 && (tokens[i-1] == "{" || tokens[i-1] == ",")
		if (!global || tokens[i+1] != "=") && (!field || tokens[i+1] != ":") {
			continue
		}
		value := strings.Trim(tokens[i+2], "\"'")
		if value != "1" && value != "true" {
			continue
		}
		end := i + 3
		if end+1 < len(tokens) && tokens[end] == "*" && tokens[end+1] == "1" {
			end += 2
		}
		if end == len(tokens) || tokens[end] == ";" || tokens[end] == "," || tokens[end] == "}" {
			return true
		}
	}
	return false
}
