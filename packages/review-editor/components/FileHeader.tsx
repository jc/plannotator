import React, { useRef, useState } from 'react';
import type {
  FileCheckpointAction,
  FileRevisionStripResponse,
  FileReviewStatus,
  FileViewMode,
} from '@plannotator/shared/types';

interface FileHeaderProps {
  filePath: string;
  patch: string;
  reviewStatus: FileReviewStatus;
  viewMode: FileViewMode;
  deltaAvailable: boolean;
  revisionStrip?: FileRevisionStripResponse;
  selectedFloorRevisionId?: string | null;
  selectedCeilingRevisionId?: string | null;
  onSelectFloorRevision?: (revisionId: string | null) => void;
  onSelectCeilingRevision?: (revisionId: string) => void;
  onSetViewMode?: (mode: FileViewMode) => void;
  onCheckpointAction?: (action: FileCheckpointAction) => void;
  isUpdatingReviewState?: boolean;
  isStaged?: boolean;
  isStaging?: boolean;
  onStage?: () => void;
  canStage?: boolean;
  stageError?: string | null;
  onFileComment?: (anchorEl: HTMLElement) => void;
}

const STATUS_LABEL: Record<FileReviewStatus, string> = {
  unreviewed: 'Unreviewed',
  reviewed: 'Reviewed',
  'needs-rereview': 'Needs rereview',
  skipped: 'Skipped',
};

/** Sticky file header with file path, review controls, strip, Git Add, and Copy Diff button */
export const FileHeader: React.FC<FileHeaderProps> = ({
  filePath,
  patch,
  reviewStatus,
  viewMode,
  deltaAvailable,
  revisionStrip,
  selectedFloorRevisionId = null,
  selectedCeilingRevisionId = null,
  onSelectFloorRevision,
  onSelectCeilingRevision,
  onSetViewMode,
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

  const reviewedRevisionId = revisionStrip?.reviewedRevisionId;
  const headRevisionId = revisionStrip?.headRevisionId;
  const canReviewFromCheckpoint = !!reviewedRevisionId;

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
        <span className={`file-status-chip ${reviewStatus}`}>
          {STATUS_LABEL[reviewStatus]}
        </span>

        {onSetViewMode && (
          <div className="flex items-center gap-1 bg-muted rounded-md p-0.5">
            <button
              onClick={() => onSetViewMode('delta')}
              disabled={!deltaAvailable || !canReviewFromCheckpoint || isUpdatingReviewState}
              className={`px-2 py-1 text-xs rounded transition-colors ${
                viewMode === 'delta'
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              } ${(!deltaAvailable || !canReviewFromCheckpoint || isUpdatingReviewState) ? 'opacity-50 cursor-not-allowed' : ''}`}
              title={canReviewFromCheckpoint ? 'Jump to reviewed checkpoint as the diff floor' : 'Mark the file reviewed first to use checkpoint-based diff floors'}
            >
              Review new changes
            </button>
            <button
              onClick={() => onSetViewMode('full')}
              disabled={isUpdatingReviewState}
              className={`px-2 py-1 text-xs rounded transition-colors ${
                viewMode === 'full'
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              } ${isUpdatingReviewState ? 'opacity-50 cursor-not-allowed' : ''}`}
              title="Show full current patch"
            >
              Review all changes
            </button>
          </div>
        )}

        {onCheckpointAction && (
          <>
            <button
              onClick={() => onCheckpointAction('mark-reviewed')}
              disabled={isUpdatingReviewState}
              className={`text-xs px-2 py-1 rounded transition-colors flex items-center gap-1 ${
                isUpdatingReviewState
                  ? 'opacity-50 cursor-not-allowed text-muted-foreground'
                  : 'bg-success/15 text-success hover:bg-success/25'
              }`}
              title="Persist reviewed checkpoint through selected revision"
            >
              Mark reviewed through here
            </button>
            <button
              onClick={() => onCheckpointAction('skip')}
              disabled={isUpdatingReviewState}
              className={`text-xs px-2 py-1 rounded transition-colors ${
                isUpdatingReviewState
                  ? 'opacity-50 cursor-not-allowed text-muted-foreground'
                  : 'bg-warning/15 text-warning hover:bg-warning/25'
              }`}
              title="Skip this file for now"
            >
              Skip for now
            </button>
            <button
              onClick={() => onCheckpointAction('reset')}
              disabled={isUpdatingReviewState || reviewStatus === 'unreviewed'}
              className={`text-xs px-2 py-1 rounded transition-colors ${
                isUpdatingReviewState || reviewStatus === 'unreviewed'
                  ? 'opacity-50 cursor-not-allowed text-muted-foreground'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted'
              }`}
              title="Clear reviewed checkpoint for this file"
            >
              Clear reviewed state
            </button>
          </>
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
