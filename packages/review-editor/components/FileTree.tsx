import React, { useEffect, useCallback, useState, useMemo } from 'react';
import { CodeAnnotation } from '@plannotator/ui/types';
import type { DiffOption, FileReviewState, WorktreeInfo } from '@plannotator/shared/types';
import { buildFileTree, getAncestorPaths, getAllFolderPaths } from '../utils/buildFileTree';
import { FileTreeNodeItem } from './FileTreeNode';

interface DiffFile {
  path: string;
  oldPath?: string;
  patch: string;
  additions: number;
  deletions: number;
}

interface FileTreeProps {
  files: DiffFile[];
  activeFileIndex: number;
  onSelectFile: (index: number) => void;
  annotations: CodeAnnotation[];
  reviewStates: Record<string, FileReviewState>;
  enableKeyboardNav?: boolean;
  diffOptions?: DiffOption[];
  activeDiffType?: string;
  onSelectDiff?: (diffType: string) => void;
  isLoadingDiff?: boolean;
  width?: number;
  worktrees?: WorktreeInfo[];
  activeWorktreePath?: string | null;
  onSelectWorktree?: (path: string | null) => void;
  currentBranch?: string;
  stagedFiles?: Set<string>;
}

const getFileKey = (path: string, oldPath?: string) => `${oldPath || ''}::${path}`;

export const FileTree: React.FC<FileTreeProps> = ({
  files,
  activeFileIndex,
  onSelectFile,
  annotations,
  reviewStates,
  enableKeyboardNav = true,
  diffOptions,
  activeDiffType,
  onSelectDiff,
  isLoadingDiff,
  width,
  worktrees,
  activeWorktreePath,
  onSelectWorktree,
  currentBranch,
  stagedFiles,
}) => {
  // Keyboard navigation: j/k or arrow keys
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (!enableKeyboardNav) return;

    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
      return;
    }

    if (e.key === 'j' || e.key === 'ArrowDown') {
      e.preventDefault();
      const nextIndex = Math.min(activeFileIndex + 1, files.length - 1);
      onSelectFile(nextIndex);
    } else if (e.key === 'k' || e.key === 'ArrowUp') {
      e.preventDefault();
      const prevIndex = Math.max(activeFileIndex - 1, 0);
      onSelectFile(prevIndex);
    } else if (e.key === 'Home') {
      e.preventDefault();
      onSelectFile(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      onSelectFile(files.length - 1);
    }
  }, [enableKeyboardNav, activeFileIndex, files.length, onSelectFile]);

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  const annotationCountMap = useMemo(() => {
    const map = new Map<string, number>();
    for (const a of annotations) {
      map.set(a.filePath, (map.get(a.filePath) ?? 0) + 1);
    }
    return map;
  }, [annotations]);

  const getAnnotationCount = useCallback((filePath: string) => {
    return annotationCountMap.get(filePath) ?? 0;
  }, [annotationCountMap]);

  const getReviewState = useCallback((filePath: string, oldPath?: string) => {
    return reviewStates[getFileKey(filePath, oldPath)] || reviewStates[getFileKey(filePath)];
  }, [reviewStates]);

  const reviewedCount = useMemo(() => {
    return files.reduce((count, file) => {
      const state = getReviewState(file.path, file.oldPath);
      return count + (state?.status === 'reviewed' ? 1 : 0);
    }, 0);
  }, [files, getReviewState]);

  const needsRereviewCount = useMemo(() => {
    return files.reduce((count, file) => {
      const state = getReviewState(file.path, file.oldPath);
      return count + (state?.status === 'needs-rereview' ? 1 : 0);
    }, 0);
  }, [files, getReviewState]);

  const tree = useMemo(() => buildFileTree(files), [files]);

  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [prevTree, setPrevTree] = useState(tree);

  // Expand all folders when tree changes (initial render + diff switch)
  if (tree !== prevTree) {
    setPrevTree(tree);
    setExpandedFolders(new Set(getAllFolderPaths(tree)));
  }

  // Auto-expand ancestors of the active file so j/k nav always reveals the target
  useEffect(() => {
    if (files[activeFileIndex]) {
      const ancestors = getAncestorPaths(files[activeFileIndex].path);
      setExpandedFolders(prev => {
        const missing = ancestors.filter(p => !prev.has(p));
        if (missing.length === 0) return prev;
        const next = new Set(prev);
        for (const p of missing) next.add(p);
        return next;
      });
    }
  }, [activeFileIndex, files]);

  const handleToggleFolder = useCallback((path: string) => {
    setExpandedFolders(prev => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  return (
    <aside className="border-r border-border bg-card/30 flex flex-col flex-shrink-0 overflow-hidden" style={{ width: width ?? 256 }}>
      {/* Header */}
      <div className="p-3 border-b border-border/50">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Files
          </span>
          <div className="flex items-center gap-1.5">
            {stagedFiles && stagedFiles.size > 0 && (
              <>
                <span className="text-xs text-primary font-medium">
                  {stagedFiles.size} added
                </span>
                <span className="text-muted-foreground/40">·</span>
              </>
            )}
            {needsRereviewCount > 0 && (
              <>
                <span className="text-xs text-warning font-medium">{needsRereviewCount} rereview</span>
                <span className="text-muted-foreground/40">·</span>
              </>
            )}
            <span className="text-xs text-muted-foreground">
              {reviewedCount}/{files.length} reviewed
            </span>
          </div>
        </div>
      </div>

      {/* Worktree context switcher — only shown when worktrees exist */}
      {worktrees && worktrees.length > 0 && onSelectWorktree && (
        <div className="px-2 pt-2 pb-1.5 border-b border-border/30">
          <div className="text-[10px] text-muted-foreground/60 uppercase tracking-wider mb-1 px-0.5">Context</div>
          <div className="relative">
            <select
              value={activeWorktreePath || ''}
              onChange={(e) => onSelectWorktree(e.target.value || null)}
              disabled={isLoadingDiff}
              className={`w-full px-2.5 py-1.5 rounded-md text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary/50 cursor-pointer disabled:opacity-50 disabled:cursor-wait appearance-none pr-7 ${
                activeWorktreePath
                  ? 'bg-primary/10 border border-primary/30'
                  : 'bg-muted'
              }`}
            >
              <option value="">{currentBranch || 'Main repo'}</option>
              {worktrees.map(wt => (
                <option key={wt.path} value={wt.path}>
                  {(wt.branch || wt.path.split('/').pop()) + ' (worktree)'}
                </option>
              ))}
            </select>
            <div className="absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none">
              <svg className="w-3.5 h-3.5 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
              </svg>
            </div>
          </div>
        </div>
      )}

      {/* Diff type selector — always the same base options */}
      {diffOptions && diffOptions.length > 0 && onSelectDiff && (
        <div className="px-2 py-1.5 border-b border-border/30">
          {worktrees && worktrees.length > 0 && (
            <div className="text-[10px] text-muted-foreground/60 uppercase tracking-wider mb-1 px-0.5">View</div>
          )}
          <div className="relative">
            <select
              value={activeDiffType || 'uncommitted'}
              onChange={(e) => onSelectDiff(e.target.value)}
              disabled={isLoadingDiff}
              className="w-full px-2.5 py-1.5 bg-muted rounded-md text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary/50 cursor-pointer disabled:opacity-50 disabled:cursor-wait appearance-none pr-7"
            >
              {diffOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
            <div className="absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none">
              {isLoadingDiff ? (
                <svg className="w-3.5 h-3.5 text-muted-foreground animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
              ) : (
                <svg className="w-3.5 h-3.5 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                </svg>
              )}
            </div>
          </div>
        </div>
      )}

      {/* File tree */}
      <div className="flex-1 overflow-y-auto p-2">
        {tree.map(node => (
          <FileTreeNodeItem
            key={node.type === 'file' ? node.path : `folder:${node.path}`}
            node={node}
            expandedFolders={expandedFolders}
            onToggleFolder={handleToggleFolder}
            activeFileIndex={activeFileIndex}
            onSelectFile={onSelectFile}
            getAnnotationCount={getAnnotationCount}
            stagedFiles={stagedFiles}
            getReviewState={getReviewState}
          />
        ))}
      </div>

      {/* Footer */}
      <div className="p-3 border-t border-border/50 text-xs text-muted-foreground space-y-2">
        <div className="flex justify-between">
          <span>Total changes:</span>
          <span className="file-stats">
            <span className="additions">
              +{files.reduce((sum, f) => sum + f.additions, 0)}
            </span>
            <span className="deletions">
              -{files.reduce((sum, f) => sum + f.deletions, 0)}
            </span>
          </span>
        </div>
        {enableKeyboardNav && (
          <div className="text-[10px] text-muted-foreground/50 text-center">
            j/k or arrows to navigate
          </div>
        )}
      </div>
    </aside>
  );
};
