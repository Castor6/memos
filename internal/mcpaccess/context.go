// Package mcpaccess marks requests originating from the trusted MCP adapter.
package mcpaccess

import "context"

type contextKey struct{}

// WithRequest marks an internal MCP request without relying on HTTP headers.
func WithRequest(ctx context.Context) context.Context {
	return context.WithValue(ctx, contextKey{}, true)
}

// IsRequest reports whether the request came through the MCP adapter.
func IsRequest(ctx context.Context) bool {
	value, ok := ctx.Value(contextKey{}).(bool)
	return ok && value
}
