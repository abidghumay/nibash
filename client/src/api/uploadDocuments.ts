import { apiClient } from "./client";

export async function uploadListingDocuments(
  listingId: string,
  documentType: string,
  files: File[],
) {
  if (files.length !== 1) throw new Error("Upload one file; combine all pages into one PDF.");
  const formData = new FormData();
  formData.append("document_type", documentType);
  files.forEach((file) => formData.append("files", file));

  return apiClient.postForm<{ documentId: number; mediaIds: number[] }>(
    `/documents/listings/${listingId}`,
    formData,
  );
}

export async function fetchListingDocuments(listingId: string) {
  return apiClient.get<{
    documents: {
      id: number;
      document_type: string;
      is_verified: boolean;
      media: { id: number; url: string }[];
    }[];
  }>(`/documents/listings/${listingId}`);
}