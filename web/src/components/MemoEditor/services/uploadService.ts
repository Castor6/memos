import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { attachmentServiceClient } from "@/connect";
import { getActiveSpace } from "@/lib/personal-space";
import type { Attachment, UploadAttachmentRequest, UploadAttachmentResponse } from "@/types/proto/api/v1/attachment_service_pb";
import { AttachmentSchema, MotionMediaSchema, UploadAttachmentRequestSchema } from "@/types/proto/api/v1/attachment_service_pb";
import type { LocalFile } from "../types/attachment";

const CHUNK_SIZE = 2 * 1024 * 1024;
// Keep a failed upload resumable while the editor still owns the same File.
const sessions = new WeakMap<File, { space: string; id: string; chunkSize: number }>();

async function sendChunk(request: UploadAttachmentRequest, space: string): Promise<UploadAttachmentResponse> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await attachmentServiceClient.uploadAttachment(request, { headers: { "X-Memos-Space": space } });
    } catch (error) {
      const code = ConnectError.from(error).code;
      if (attempt >= 2 || (code !== Code.Unavailable && code !== Code.DeadlineExceeded)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
    }
  }
}

async function uploadFile(localFile: LocalFile, space: string): Promise<Attachment> {
  const { file, motionMedia } = localFile;
  let session = sessions.get(file);
  if (session && session.space !== space) {
    throw new ConnectError("Resume this upload in its original personal space", Code.FailedPrecondition);
  }
  let response: UploadAttachmentResponse;
  if (session) {
    // An empty write reports committed bytes, including a final response lost in transit.
    try {
      response = await sendChunk(create(UploadAttachmentRequestSchema, { upload: { case: "uploadId", value: session.id } }), space);
    } catch (error) {
      if (ConnectError.from(error).code === Code.NotFound) sessions.delete(file);
      throw error;
    }
  } else {
    response = await sendChunk(
      create(UploadAttachmentRequestSchema, {
        upload: {
          case: "spec",
          value: {
            attachment: create(AttachmentSchema, {
              filename: file.name,
              type: file.type,
              motionMedia: motionMedia ? create(MotionMediaSchema, motionMedia) : undefined,
            }),
            totalSize: BigInt(file.size),
          },
        },
      }),
      space,
    );
    if (!response.uploadId || response.maxChunkSize <= 0) throw new ConnectError("Invalid upload session", Code.Internal);
    session = { space, id: response.uploadId, chunkSize: Math.min(CHUNK_SIZE, response.maxChunkSize) };
    sessions.set(file, session);
  }
  while (!response.attachment) {
    const offset = Number(response.committedSize);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > file.size) throw new ConnectError("Invalid upload offset", Code.Internal);
    const end = Math.min(offset + session.chunkSize, file.size);
    const data = new Uint8Array(await file.slice(offset, end).arrayBuffer());
    response = await sendChunk(
      create(UploadAttachmentRequestSchema, {
        upload: { case: "uploadId", value: session.id },
        writeOffset: BigInt(offset),
        data,
        finishWrite: end === file.size,
      }),
      space,
    );
    if (!response.attachment && (end === file.size || Number(response.committedSize) !== end))
      throw new ConnectError("Upload did not advance", Code.Internal);
  }
  return response.attachment;
}

export const uploadService = {
  async uploadFiles(localFiles: LocalFile[]): Promise<Attachment[]> {
    const space = getActiveSpace();
    const attachments: Attachment[] = [];
    for (const localFile of localFiles) attachments.push(await uploadFile(localFile, space));
    return attachments;
  },
};
