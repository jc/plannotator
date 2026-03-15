import React, { useState } from 'react';
import type { FileCheckpointAction, FileReviewStatus, FileViewMode } from '@plannotator/shared/types';

interface FileHeaderProps {
  filePath: string;
  patch: string;
  reviewStatus: FileReviewStatus;
  viewMode: FileViewMode;
  deltaAvailable: boolean;
  onSetViewMode?: (mode: FileViewMode) => void;
  onCheckpointAction?: (action: FileCheckpointAction) => void;
  isUpdatingReviewState?: boolean;
  isStaged?: boolean;
  isStaging?: boolean;
  onStage?: () => void;
  canStage?: boolean;
  stageError?: string | null;
}

const STATUS_LABEL: Record<FileReviewStatus, string> = {
  unreviewed: 'Unreviewed',
  reviewed: 'Reviewed',
  'needs-rereview': 'Needs rereview',
  skipped: 'Skipped',
};

/** Sticky file header with file path, review controls, Git Add, and Copy Diff button */
export const FileHeader: React.FC<FileHeaderProps> = ({
  filePath,
  patch,
  reviewStatus,
  viewMode,
  deltaAvailable,
  onSetViewMode,
  onCheckpointAction,
  isUpdatingReviewState = false,
  isStaged = false,
  isStaging = false,
  onStage,
  canStage = false,
  stageError,
}) => {
  const [copied, setCopied] = useState(false);

  return (
    <div className="sticky top-0 z-10 px-4 py-2 bg-card/95 backdrop-blur border-b border-border flex items-center justify-between gap-4">
      <div className="min-w-0">
        <div className="font-mono text-sm text-foreground truncate">{filePath}</div>
      </div>

      <div className="flex items-center gap-2 flex-wrap justify-end">
        <span className={`file-status-chip ${reviewStatus}`}>
          {STATUS_LABEL[reviewStatus]}
        </span>

        {onSetViewMode && (
          <div className="flex items-center gap-1 bg-muted rounded-md p-0.5">
            <button
              onClick={() => onSetViewMode('delta')}
              disabled={!deltaAvailable || isUpdatingReviewState}
              className={`px-2 py-1 text-xs rounded transition-colors ${
                viewMode === 'delta'
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              } ${(!deltaAvailable || isUpdatingReviewState) ? 'opacity-50 cursor-not-allowed' : ''}`}
              title={deltaAvailable ? 'Show only changes since your last reviewed checkpoint' : 'Delta view is available after you review and the file changes again'}
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
              title="Mark reviewed at this revision"
            >
              Mark reviewed
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
              title="Reset review checkpoint for this file"
            >
              Reset
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
