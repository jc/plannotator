import React, { useRef, useState } from 'react';
import type {
  FileCheckpointAction,
  FileRevisionStripResponse,
  FileReviewStatus,
} from '@plannotator/shared/types';

interface FileHeaderProps {
  filePath: string;
  patch: string;
  reviewStatus: FileReviewStatus;
  revisionStrip?: FileRevisionStripResponse;
  selectedFloorRevisionId?: string | null;
  selectedCeilingRevisionId?: string | null;
  onSelectFloorRevision?: (revisionId: string | null) => void;
  onSelectCeilingRevision?: (revisionId: string) => void;
  onCheckpointAction?: (action: FileCheckpointAction) => void;
  isUpdatingReviewState?: boolean;
  isStaged?: boolean;
  isStaging?: boolean;
  onStage?: () => void;
  canStage?: boolean;
  stageError?: string | null;
  onFileComment?: (anchorEl: HTMLElement) => void;
}

/** Sticky file header with file path, revision strip, review toggle, and utility actions */
export const FileHeader: React.FC<FileHeaderProps> = ({
  filePath,
  patch,
  reviewStatus,
  revisionStrip,
  selectedFloorRevisionId = null,
  selectedCeilingRevisionId = null,
  onSelectFloorRevision,
  onSelectCeilingRevision,
  onCheckpointAction,
  isUpdatingReviewState = false,
  isStaged = false,
  isStaging = false,
  onStage,
  canStage = false,
  stageError,
  onFileComment,
}) => {
  const [copied, setCopied] = useState(false);
  const fileCommentRef = useRef<HTMLButtonElement>(null);

  const reviewedRevisionId = revisionStrip?.reviewedRevisionId || null;
  const headRevisionId = revisionStrip?.headRevisionId;
  const selectedToRevisionId = selectedCeilingRevisionId || headRevisionId || null;

  const revisionOrder = (revisionId: string | null | undefined): number => {
    if (!revisionStrip || !revisionId) return -1;
    return revisionStrip.cells.findIndex((cell) => cell.revisionId === revisionId);
  };

  const reviewedThroughTo = (() => {
    const reviewedOrder = revisionOrder(reviewedRevisionId);
    const selectedToOrder = revisionOrder(selectedToRevisionId);

    if (reviewedOrder !== -1 && selectedToOrder !== -1) {
      return reviewedOrder >= selectedToOrder;
    }

    return reviewStatus === 'reviewed';
  })();

  const reviewToggleAction: FileCheckpointAction = reviewedThroughTo ? 'reset' : 'mark-reviewed';
  const reviewToggleTitle = reviewedThroughTo
    ? 'Reviewed through the selected To revision. Click to clear reviewed state.'
    : 'Not reviewed through the selected To revision. Click to mark reviewed through here.';

  const skipAction: FileCheckpointAction = reviewStatus === 'skipped' ? 'reset' : 'skip';
  const skipLabel = reviewStatus === 'skipped' ? 'Unskip' : 'Skip for now';
  const skipTitle = reviewStatus === 'skipped'
    ? 'Remove skipped status for this file'
    : 'Skip this file for now';

  const cellTitle = (cell: NonNullable<typeof revisionStrip>["cells"][number], side: "From" | "To"): string => {
    const revisionLabel = cell.label || cell.revisionId.slice(0, 8);
    return `${side} ${revisionLabel} · ${new Date(cell.createdAt).toLocaleString()}`;
  };

  return (
    <div className="sticky top-0 z-10 px-4 py-2 bg-card/95 backdrop-blur border-b border-border flex items-center justify-between gap-4">
      <div className="min-w-0 space-y-1">
        <div className="font-mono text-sm leading-tight text-foreground break-all whitespace-normal">{filePath}</div>

        {revisionStrip && revisionStrip.cells.length > 0 && onSelectFloorRevision && (
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground/70 w-8">From</span>

              <button
                onClick={() => onSelectFloorRevision(null)}
                disabled={isUpdatingReviewState}
                className={`review-strip-all ${selectedFloorRevisionId ? '' : 'selected'} ${isUpdatingReviewState ? 'disabled' : ''}`}
                title="Use base/full floor"
              >
                Base
              </button>

              <div className="review-strip-cells">
                {revisionStrip.cells.map((cell) => {
                  const isSelected = selectedFloorRevisionId === cell.revisionId;
                  const isReviewed = cell.revisionId === reviewedRevisionId;

                  return (
                    <button
                      key={`floor-${cell.revisionId}`}
                      onClick={() => onSelectFloorRevision(cell.revisionId)}
                      disabled={isUpdatingReviewState}
                      className={`review-strip-cell ${
                        isSelected ? 'selected' : ''
                      } ${
                        isReviewed ? 'reviewed' : ''
                      } ${
                        isUpdatingReviewState ? 'disabled' : ''
                      }`}
                      title={cellTitle(cell, 'From')}
                    >
                      <span className="review-strip-cell-dot" />
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="flex items-center gap-2">
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground/70 w-8">To</span>

              <span className="review-strip-all review-strip-all-spacer" aria-hidden="true">
                Base
              </span>

              <div className="review-strip-cells">
                {revisionStrip.cells.map((cell) => {
                  const isSelected = selectedCeilingRevisionId === cell.revisionId;
                  const isHead = cell.revisionId === headRevisionId;
                  const isReviewed = cell.revisionId === reviewedRevisionId;

                  return (
                    <button
                      key={`ceiling-${cell.revisionId}`}
                      onClick={() => onSelectCeilingRevision?.(cell.revisionId)}
                      disabled={isUpdatingReviewState || !onSelectCeilingRevision}
                      className={`review-strip-cell ceiling ${
                        isSelected ? 'selected' : ''
                      } ${
                        isHead ? 'head' : ''
                      } ${
                        isReviewed ? 'reviewed' : ''
                      } ${
                        isUpdatingReviewState ? 'disabled' : ''
                      }`}
                      title={cellTitle(cell, 'To')}
                    >
                      <span className="review-strip-cell-dot" />
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 flex-wrap justify-end">
        {onCheckpointAction && (
          <button
            onClick={() => onCheckpointAction(reviewToggleAction)}
            disabled={isUpdatingReviewState}
            className={`review-toggle ${reviewedThroughTo ? 'reviewed' : 'pending'} ${isUpdatingReviewState ? 'disabled' : ''}`}
            title={reviewToggleTitle}
            aria-label={reviewToggleTitle}
          >
            {reviewedThroughTo ? (
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.27 2.943 9.543 7-1.274 4.057-5.065 7-9.543 7-4.477 0-8.268-2.943-9.542-7z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
            ) : (
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 3l18 18" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M10.584 10.587A2 2 0 0012 14a2 2 0 001.414-.586" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M9.88 5.09A9.95 9.95 0 0112 5c4.478 0 8.27 2.943 9.543 7a9.97 9.97 0 01-4.132 5.112" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M6.228 6.232A9.965 9.965 0 002.458 12c1.274 4.057 5.065 7 9.543 7 1.596 0 3.106-.37 4.45-1.03" />
              </svg>
            )}
          </button>
        )}

        {onCheckpointAction && (
          <button
            onClick={() => onCheckpointAction(skipAction)}
            disabled={isUpdatingReviewState}
            className={`text-xs px-2 py-1 rounded transition-colors ${
              isUpdatingReviewState
                ? 'opacity-50 cursor-not-allowed text-muted-foreground'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted'
            }`}
            title={skipTitle}
          >
            {skipLabel}
          </button>
        )}

        {canStage && onStage && (
          <button
            onClick={onStage}
            disabled={isStaging}
            className={`text-xs px-2 py-1 rounded transition-colors flex items-center gap-1 ${
              isStaging
                ? 'opacity-50 cursor-not-allowed text-muted-foreground'
                : isStaged
                  ? 'bg-primary/15 text-primary'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted'
            }`}
            title={isStaged ? 'Unstage this file (git reset)' : 'Stage this file (git add)'}
          >
            {isStaging ? (
              <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
            ) : isStaged ? (
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            ) : (
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
              </svg>
            )}
            {isStaging ? 'Adding...' : isStaged ? 'Added' : 'Git Add'}
          </button>
        )}

        {stageError && (
          <span className="text-xs text-destructive">{stageError}</span>
        )}
        {onFileComment && (
          <button
            ref={fileCommentRef}
            onClick={() => fileCommentRef.current && onFileComment(fileCommentRef.current)}
            className="text-xs px-2 py-1 rounded transition-colors flex items-center gap-1 text-muted-foreground hover:text-foreground hover:bg-muted"
            title="Add file-scoped comment"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-4l-4 4v-4z" />
            </svg>
            File Comment
          </button>
        )}
        <button
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(patch);
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            } catch (err) {
              console.error('Failed to copy:', err);
            }
          }}
          className="text-xs text-muted-foreground hover:text-foreground px-2 py-1 rounded hover:bg-muted transition-colors flex items-center gap-1"
          title="Copy this file's diff"
        >
          {copied ? (
            <>
              <svg className="w-3.5 h-3.5 text-success" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
              Copied!
            </>
          ) : (
            <>
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
              Copy Diff
            </>
          )}
        </button>
      </div>
    </div>
  );
};
