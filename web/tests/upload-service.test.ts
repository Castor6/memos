import { File as BufferFile } from "node:buffer";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { uploadService } from "@/components/MemoEditor/services/uploadService";
import type { LocalFile } from "@/components/MemoEditor/types/attachment";
import {
  AttachmentSchema,
  MotionMediaFamily,
  MotionMediaRole,
  MotionMediaSchema,
  UploadAttachmentResponseSchema,
} from "@/types/proto/api/v1/attachment_service_pb";

const mocks = vi.hoisted(() => ({ upload: vi.fn(), space: "work" }));
vi.mock("@/connect", () => ({ attachmentServiceClient: { uploadAttachment: mocks.upload } }));
vi.mock("@/lib/personal-space", () => ({ getActiveSpace: () => mocks.space }));
const MiB = 1024 * 1024;
const attachment = create(AttachmentSchema, { name: "attachments/result", filename: "file.pdf" });
function localFile(size = 3 * MiB): LocalFile {
  return { file: new BufferFile([new Uint8Array(size)], "file.pdf", { type: "application/pdf" }) as unknown as File, previewUrl: "" };
}
const response = (offset: number, complete = false) =>
  create(UploadAttachmentResponseSchema, {
    uploadId: "session",
    maxChunkSize: 2 * MiB,
    committedSize: BigInt(offset),
    attachment: complete ? attachment : undefined,
  });
beforeEach(() => {
  mocks.space = "work";
});

describe("chunked editor uploads", () => {
  it("slices large files and pins the original space even while navigation changes", async () => {
    const file = localFile(5 * MiB);
    const fullRead = vi.spyOn(file.file, "arrayBuffer").mockRejectedValue(new Error("must not read a whole file"));
    mocks.upload.mockImplementation(async (request) => {
      mocks.space = "personal";
      return request.upload.case === "spec"
        ? response(0)
        : response(Number(request.writeOffset) + request.data.length, request.finishWrite);
    });
    expect(await uploadService.uploadFiles([file])).toEqual([attachment]);
    expect(fullRead).not.toHaveBeenCalled();
    expect(mocks.upload.mock.calls.map(([request]) => request.data.length)).toEqual([0, 2 * MiB, 2 * MiB, MiB]);
    expect(mocks.upload.mock.calls.map(([request]) => request.writeOffset)).toEqual([0n, 0n, BigInt(2 * MiB), BigInt(4 * MiB)]);
    for (const [, options] of mocks.upload.mock.calls) expect(options.headers["X-Memos-Space"]).toBe("work");
  });

  it("retries identical bytes and offset after a lost response", async () => {
    const file = localFile(17);
    mocks.upload
      .mockResolvedValueOnce(response(0))
      .mockRejectedValueOnce(new ConnectError("network", Code.Unavailable))
      .mockResolvedValueOnce(response(17, true));
    expect(await uploadService.uploadFiles([file])).toEqual([attachment]);
    expect(mocks.upload.mock.calls[1][0]).toBe(mocks.upload.mock.calls[2][0]);
    expect(mocks.upload).toHaveBeenCalledTimes(3);
  });

  it("resumes a manual retry at server committed bytes without starting another upload", async () => {
    const file = localFile();
    mocks.upload.mockResolvedValueOnce(response(0)).mockRejectedValueOnce(new ConnectError("lost outcome", Code.Internal));
    await expect(uploadService.uploadFiles([file])).rejects.toMatchObject({ code: Code.Internal });
    mocks.upload.mockResolvedValueOnce(response(2 * MiB)).mockResolvedValueOnce(response(3 * MiB, true));
    expect(await uploadService.uploadFiles([file])).toEqual([attachment]);
    const calls = mocks.upload.mock.calls;
    expect(calls.filter(([request]) => request.upload.case === "spec")).toHaveLength(1);
    expect(calls[2][0].data.length).toBe(0);
    expect(calls[3][0].writeOffset).toBe(BigInt(2 * MiB));
    expect(calls[3][0].data.length).toBe(MiB);
    mocks.upload.mockResolvedValueOnce(response(3 * MiB, true));
    expect(await uploadService.uploadFiles([file])).toEqual([attachment]);
    expect(mocks.upload.mock.calls.at(-1)?.[0].data.length).toBe(0);
  });

  it("reports expired sessions instead of silently restarting an uncertain upload", async () => {
    const file = localFile(8);
    mocks.upload.mockResolvedValueOnce(response(0)).mockRejectedValueOnce(new ConnectError("write failed", Code.Internal));
    await expect(uploadService.uploadFiles([file])).rejects.toMatchObject({ code: Code.Internal });
    mocks.upload.mockRejectedValueOnce(new ConnectError("upload not found or expired", Code.NotFound));
    await expect(uploadService.uploadFiles([file])).rejects.toMatchObject({ code: Code.NotFound });
    expect(mocks.upload.mock.calls.filter(([request]) => request.upload.case === "spec")).toHaveLength(1);
  });

  it("requires returning to the original space for manual retries", async () => {
    const file = localFile(8);
    mocks.upload.mockResolvedValueOnce(response(0)).mockRejectedValueOnce(new ConnectError("write failed", Code.Internal));
    await expect(uploadService.uploadFiles([file])).rejects.toMatchObject({ code: Code.Internal });
    mocks.space = "other";
    await expect(uploadService.uploadFiles([file])).rejects.toMatchObject({ code: Code.FailedPrecondition });
    expect(mocks.upload).toHaveBeenCalledTimes(2);
  });

  it("finalizes empty files and preserves explicit motion media", async () => {
    const file = {
      ...localFile(0),
      motionMedia: create(MotionMediaSchema, { family: MotionMediaFamily.APPLE_LIVE_PHOTO, role: MotionMediaRole.VIDEO, groupId: "group" }),
    };
    mocks.upload.mockResolvedValueOnce(response(0)).mockResolvedValueOnce(response(0, true));
    expect(await uploadService.uploadFiles([file])).toEqual([attachment]);
    expect(mocks.upload.mock.calls[0][0].upload.value.attachment.motionMedia).toEqual(file.motionMedia);
    expect(mocks.upload.mock.calls[1][0]).toMatchObject({ data: new Uint8Array(), finishWrite: true, writeOffset: 0n });
  });
});
