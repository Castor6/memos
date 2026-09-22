package filter

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestCaptureFiltersAcrossDialects(t *testing.T) {
	engine, err := NewEngine(NewSchema())
	require.NoError(t, err)
	for _, dialect := range []DialectName{DialectSQLite, DialectMySQL, DialectPostgres} {
		t.Run(string(dialect), func(t *testing.T) {
			program, err := engine.Compile(context.Background(), `has_capture == true && capture_kind == "PICK_UP" && capture_source_id == "2102063913437376776"`)
			require.NoError(t, err)
			require.True(t, program.ReferencesField("capture_source_id"))
			statement, err := program.Render(RenderOptions{Dialect: dialect})
			require.NoError(t, err)
			require.Contains(t, statement.SQL, "IS NOT NULL")
			require.Contains(t, statement.Args, "PICK_UP")
			require.Contains(t, statement.Args, "2102063913437376776")
			if dialect == DialectMySQL {
				require.Contains(t, statement.SQL, "JSON_UNQUOTE")
			}
			for _, expression := range []string{`has_capture`, `!has_capture`, `has_capture == false`, `capture_source_url == "https://example.com/?q='"`} {
				_, err := engine.CompileToStatement(context.Background(), expression, RenderOptions{Dialect: dialect})
				require.NoError(t, err)
			}
		})
	}
	program, err := engine.Compile(context.Background(), `content.contains("capture_kind")`)
	require.NoError(t, err)
	require.False(t, program.ReferencesField("capture_kind"), "a search term is not a capture field reference")
	for _, expression := range []string{`capture_kind in ["STAR"]`, `size(capture_source_id) > 0`, `has_capture || visibility == "PUBLIC"`} {
		program, err := engine.Compile(context.Background(), expression)
		require.NoError(t, err)
		require.True(t, program.ReferencesField("has_capture", "capture_kind", "capture_source_id"))
	}
}
