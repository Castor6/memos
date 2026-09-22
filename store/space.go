package store

import "context"

type spaceContextKey struct{}

// WithSpace scopes content operations to one personal space. Background jobs
// deliberately use an unscoped context to process every space.
func WithSpace(ctx context.Context, space string) context.Context {
	return context.WithValue(ctx, spaceContextKey{}, space)
}

// SpaceFromContext returns the selected space and whether scoping is enabled.
func SpaceFromContext(ctx context.Context) (string, bool) {
	space, ok := ctx.Value(spaceContextKey{}).(string)
	return space, ok
}

// WithoutSpace removes implicit content scoping for explicit cross-space queries.
// Callers must still enforce ownership and authorization.
func WithoutSpace(ctx context.Context) context.Context {
	return context.WithValue(ctx, spaceContextKey{}, struct{}{})
}
