package v1

import (
	"context"

	"connectrpc.com/connect"

	v1pb "github.com/usememos/memos/proto/gen/api/v1"
)

// ExportMemoArchive exports the authenticated user's notes through Connect.
func (s *ConnectServiceHandler) ExportMemoArchive(ctx context.Context, req *connect.Request[v1pb.ExportMemoArchiveRequest]) (*connect.Response[v1pb.ExportMemoArchiveResponse], error) {
	result, err := s.APIV1Service.ExportMemoArchive(ctx, req.Msg)
	if err != nil {
		return nil, convertGRPCError(err)
	}
	return connect.NewResponse(result), nil
}

// ImportMemoArchive imports notes through the same validation used by the gateway.
func (s *ConnectServiceHandler) ImportMemoArchive(ctx context.Context, req *connect.Request[v1pb.ImportMemoArchiveRequest]) (*connect.Response[v1pb.ImportMemoArchiveResponse], error) {
	result, err := s.APIV1Service.ImportMemoArchive(ctx, req.Msg)
	if err != nil {
		return nil, convertGRPCError(err)
	}
	return connect.NewResponse(result), nil
}
