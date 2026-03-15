import React from 'react';
import type { FileReviewState } from '@plannotator/shared/types';
import type { FileTreeNode as TreeNode } from '../utils/buildFileTree';

interface FileTreeNodeProps {
  node: TreeNode;
  expandedFolders: Set<string>;
  onToggleFolder: (path: string) => void;
  activeFileIndex: number;
  onSelectFile: (index: number) => void;
  getAnnotationCount: (filePath: string) => number;
  stagedFiles?: Set<string>;
  getReviewState: (filePath: string, oldPath?: string) => FileReviewState | undefined;
}

export const FileTreeNodeItem: React.FC<FileTreeNodeProps> = ({
  node,
  expandedFolders,
  onToggleFolder,
  activeFileIndex,
  onSelectFile,
  getAnnotationCount,
  stagedFiles,
  getReviewState,
}) => {
  const paddingLeft = 8 + node.depth * 12;

  if (node.type === 'folder') {
    const isExpanded = expandedFolders.has(node.path);

    return (
      <>
        <button
          onClick={() => onToggleFolder(node.path)}
          className="w-full flex items-center gap-1.5 py-1 px-2 text-[11px] text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors rounded-sm"
          style={{ paddingLeft }}
        >
          <svg
            className={`w-3 h-3 flex-shrink-0 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
          <span className="truncate">{node.name}</span>
          {(node.additions > 0 || node.deletions > 0) && (
            <div className="flex items-center gap-1.5 ml-auto flex-shrink-0 text-[10px]">
              <span className="additions">+{node.additions}</span>
              <span className="deletions">-{node.deletions}</span>
            </div>
          )}
        </button>
        {isExpanded && node.children?.map(child => (
          <FileTreeNodeItem
            key={child.type === 'file' ? child.path : `folder:${child.path}`}
            node={child}
            expandedFolders={expandedFolders}
            onToggleFolder={onToggleFolder}
            activeFileIndex={activeFileIndex}
            onSelectFile={onSelectFile}
            getAnnotationCount={getAnnotationCount}
            stagedFiles={stagedFiles}
            getReviewState={getReviewState}
          />
        ))}
      </>
    );
  }

  const isActive = node.fileIndex === activeFileIndex;
  const isStaged = stagedFiles?.has(node.path) ?? false;
  const annotationCount = getAnnotationCount(node.path);
  const reviewState = getReviewState(node.path, node.file?.oldPath);
  const reviewStatus = reviewState?.status || 'unreviewed';

  return (
    <button
      onClick={() => onSelectFile(node.fileIndex!)}
      className={`file-tree-item w-full text-left group ${isActive ? 'active' : ''} ${annotationCount > 0 ? 'has-annotations' : ''} ${isStaged ? 'staged' : ''}`}
      style={{ paddingLeft: paddingLeft + 15 }}
    >
      <div className="flex items-center gap-1.5 flex-1 min-w-0">
        <span className="truncate">{node.name}</span>
      </div>
      <div className="flex items-center gap-1.5 flex-shrink-0 text-[10px]">
        <span className={`file-status-chip small ${reviewStatus}`}>
          {reviewStatus === 'needs-rereview' ? 'rereview' : reviewStatus}
        </span>
        {isStaged && (
          <span className="text-primary font-medium" title="Staged (git add)">+</span>
        )}
        {annotationCount > 0 && (
          <span className="text-primary font-medium">{annotationCount}</span>
        )}
        <span className="additions">+{node.file!.additions}</span>
        <span className="deletions">-{node.file!.deletions}</span>
      </div>
    </button>
  );
};
