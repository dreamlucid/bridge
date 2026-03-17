# Rundown Export and Import Feature Implementation Plan

## Overview
This document outlines the plan for implementing export and import functionality for the rundown React component. The feature will allow users to export rundown items to a JSON file and import them back into the rundown.

## Current State Analysis

### Existing Functionality
1. **Copy/Paste System**: The rundown already has a robust copy/paste system:
   - `rundown.copyItems(itemIds)` - Serializes items to JSON string (recursively includes children)
   - `rundown.pasteItems(items, parentId, index)` - Deserializes and creates new items with new IDs
   - Located in: `plugins/rundown/index.js` (lines 273-357)

2. **Clipboard Utilities**: 
   - `clipboard.copyText(str)` - Uses `navigator.clipboard.writeText()`
   - `clipboard.readText()` - Uses `navigator.clipboard.readText()`
   - `clipboard.readJson()` - Parses clipboard text as JSON
   - Located in: `plugins/rundown/app/utils/clipboard.js`

3. **UI Components**:
   - Header component with "Add" button (`plugins/rundown/app/components/Header/index.jsx`)
   - Context menu system for item actions (`RundownListItem`)
   - Main Rundown view component (`plugins/rundown/app/views/Rundown.jsx`)

### Data Structure
- Items are stored hierarchically with `parent` and `children` relationships
- Each item has: `id`, `type`, `data`, `parent`, `children`
- The `copyItems` function recursively copies items and all their children
- The `pasteItems` function creates new IDs to avoid collisions

## Implementation Plan

### Phase 1: Backend Commands (Server-side)

#### 1.1 Export Command
**Location**: `plugins/rundown/index.js`

**Function**: `exportRundown(rundownId)`
- Get all top-level items in the rundown using `getItems(rundownId)`
- Use existing `copyItems` function to serialize all items
- Return the JSON string
- This reuses the existing serialization logic

**Implementation**:
```javascript
async function exportRundown (rundownId) {
  const itemIds = await getItems(rundownId)
  if (itemIds.length === 0) {
    return JSON.stringify([])
  }
  return await copyItems(itemIds)
}
bridge.commands.registerCommand('rundown.exportRundown', exportRundown)
```

#### 1.2 Import Command
**Location**: `plugins/rundown/index.js`

**Function**: `importRundown(rundownId, items, options)`
- Validate the items array
- Use existing `pasteItems` function to import items
- Options could include:
  - `clearExisting`: Whether to clear the rundown before importing (default: false)
  - `merge`: Whether to merge with existing items (default: true)

**Implementation**:
```javascript
async function importRundown (rundownId, items, options = {}) {
  if (!items || !Array.isArray(items)) {
    throw new Error('Invalid import data: items must be an array')
  }
  
  // Clear existing items if requested
  if (options.clearExisting) {
    const existingItems = await getItems(rundownId)
    if (existingItems.length > 0) {
      await removeItemsFromParent(rundownId, existingItems)
    }
  }
  
  // Use existing pasteItems to import
  await pasteItems(items, rundownId)
}
bridge.commands.registerCommand('rundown.importRundown', importRundown)
```

### Phase 2: File Utilities (Client-side)

#### 2.1 File Download Utility
**Location**: `plugins/rundown/app/utils/file.js` (new file)

**Functions**:
- `downloadJson(data, filename)` - Downloads JSON data as a file
- Uses browser's `Blob` and `URL.createObjectURL()` API
- Creates a temporary `<a>` element to trigger download

**Implementation**:
```javascript
export function downloadJson (data, filename = 'rundown-export.json') {
  const jsonString = typeof data === 'string' ? data : JSON.stringify(data, null, 2)
  const blob = new Blob([jsonString], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}
```

#### 2.2 File Upload Utility
**Location**: `plugins/rundown/app/utils/file.js`

**Functions**:
- `readJsonFile(file)` - Reads and parses a JSON file
- Returns a Promise that resolves to the parsed JSON
- Includes error handling for invalid files

**Implementation**:
```javascript
export function readJsonFile (file) {
  return new Promise((resolve, reject) => {
    if (!file) {
      reject(new Error('No file provided'))
      return
    }
    
    if (file.type !== 'application/json' && !file.name.endsWith('.json')) {
      reject(new Error('Invalid file type. Please select a JSON file.'))
      return
    }
    
    const reader = new FileReader()
    reader.onload = (e) => {
      try {
        const json = JSON.parse(e.target.result)
        resolve(json)
      } catch (error) {
        reject(new Error('Invalid JSON file: ' + error.message))
      }
    }
    reader.onerror = () => reject(new Error('Failed to read file'))
    reader.readAsText(file)
  })
}
```

### Phase 3: UI Components

#### 3.1 Header Component Updates
**Location**: `plugins/rundown/app/components/Header/index.jsx`

**Changes**:
- Add "Export" button next to "Add" button
- Add "Import" button next to "Export" button
- Both buttons trigger file operations

**UI Layout**:
```
[Add] [Export] [Import] | Main rundown / Group name
```

**Implementation**:
```javascript
// Add state for file input (hidden)
const fileInputRef = React.useRef()

// Export handler
async function handleExport () {
  const rundownId = rundownInfo?.id || config.DEFAULT_RUNDOWN_ID
  const jsonString = await bridge.commands.executeCommand('rundown.exportRundown', rundownId)
  const filename = `rundown-${rundownInfo?.name || 'export'}-${Date.now()}.json`
  fileUtils.downloadJson(jsonString, filename)
}

// Import handler
async function handleImport () {
  fileInputRef.current?.click()
}

// File change handler
async function handleFileChange (e) {
  const file = e.target.files?.[0]
  if (!file) return
  
  try {
    const items = await fileUtils.readJsonFile(file)
    const rundownId = rundownInfo?.id || config.DEFAULT_RUNDOWN_ID
    
    // Show confirmation dialog for merge vs replace
    const shouldClear = window.confirm(
      'Import options:\n' +
      'OK = Replace all items (clear existing)\n' +
      'Cancel = Add to existing items (merge)'
    )
    
    await bridge.commands.executeCommand('rundown.importRundown', rundownId, items, {
      clearExisting: shouldClear
    })
    
    // Reset file input
    e.target.value = ''
  } catch (error) {
    window.alert('Import failed: ' + error.message)
  }
}
```

#### 3.2 Context Menu Option (Alternative/Additional)
**Location**: `plugins/rundown/app/views/Rundown.jsx` or `RundownListItem/index.jsx`

**Option**: Add export/import to the context menu when right-clicking on the rundown area
- Export: Export entire rundown
- Import: Import items into rundown

### Phase 4: Error Handling & Validation

#### 4.1 Export Validation
- Check if rundown exists
- Handle empty rundowns gracefully
- Validate JSON serialization

#### 4.2 Import Validation
- Validate file format (must be JSON)
- Validate item structure (must have `type`, `data`, etc.)
- Check for required fields
- Handle malformed data gracefully
- Show user-friendly error messages

#### 4.3 User Feedback
- Loading indicators during export/import
- Success notifications
- Error dialogs with clear messages
- Confirmation dialogs for destructive operations (clear existing)

### Phase 5: Advanced Features (Optional)

#### 5.1 Export Options
- Export selected items only (if items are selected)
- Export with/without metadata
- Export format options (JSON, CSV, etc.)

#### 5.2 Import Options
- Merge vs Replace dialog
- Preview before import
- Partial import (select which items to import)
- Import validation report

#### 5.3 Versioning & Metadata
- Add version field to exported JSON
- Include export timestamp
- Include rundown metadata (name, ID, etc.)
- Include Bridge version for compatibility checking

## File Structure

```
plugins/rundown/
├── index.js                          # Add export/import commands
├── app/
│   ├── views/
│   │   └── Rundown.jsx               # Main rundown view (optional context menu)
│   ├── components/
│   │   ├── Header/
│   │   │   └── index.jsx            # Add Export/Import buttons
│   │   └── RundownListItem/
│   │       └── index.jsx            # (Optional) Context menu items
│   └── utils/
│       ├── clipboard.js             # Existing clipboard utilities
│       └── file.js                  # NEW: File download/upload utilities
```

## Implementation Steps

### Step 1: Create File Utilities
1. Create `plugins/rundown/app/utils/file.js`
2. Implement `downloadJson()` function
3. Implement `readJsonFile()` function
4. Test file operations in isolation

### Step 2: Add Backend Commands
1. Add `exportRundown()` command in `plugins/rundown/index.js`
2. Add `importRundown()` command in `plugins/rundown/index.js`
3. Test commands via bridge API

### Step 3: Update Header Component
1. Add Export button to Header
2. Add Import button to Header
3. Add hidden file input element
4. Wire up handlers
5. Add basic error handling

### Step 4: Add User Feedback
1. Add loading states
2. Add success/error notifications
3. Add confirmation dialogs
4. Improve error messages

### Step 5: Testing
1. Test export with empty rundown
2. Test export with single item
3. Test export with nested items (groups)
4. Test import with valid file
5. Test import with invalid file
6. Test merge vs replace
7. Test import into different rundown
8. Test edge cases (corrupted data, missing fields, etc.)

### Step 6: Documentation
1. Update README with export/import instructions
2. Add usage examples
3. Document file format
4. Document limitations

## Technical Considerations

### Browser Compatibility
- File API: Supported in all modern browsers
- Blob API: Supported in all modern browsers
- FileReader API: Supported in all modern browsers

### Security
- Validate file types (only JSON)
- Validate file size (prevent memory issues)
- Sanitize imported data
- Handle malicious JSON gracefully

### Performance
- For large rundowns, consider:
  - Progress indicators
  - Streaming/chunked processing
  - Background processing
  - Memory management

### Data Integrity
- Preserve item relationships (parent/children)
- Handle ID collisions (already handled by pasteItems)
- Maintain item order
- Preserve item metadata

## File Format Specification

### Export Format
```json
[
  {
    "id": "original-id-1",
    "type": "bridge.caspar.amcp",
    "data": {
      "name": "Item Name",
      "caspar": {
        "server": "group:0",
        "amcp": "PLAY 1-10 ..."
      }
    },
    "parent": null,
    "children": ["original-id-2"]
  },
  {
    "id": "original-id-2",
    "type": "bridge.types.group",
    "data": {
      "name": "Group Name"
    },
    "parent": "original-id-1",
    "children": []
  }
]
```

### Metadata (Optional Enhancement)
```json
{
  "version": "1.0.0",
  "exportDate": "2025-01-XX",
  "bridgeVersion": "x.x.x",
  "rundownId": "RUNDOWN_ROOT",
  "rundownName": "Main rundown",
  "items": [...]
}
```

## Testing Checklist

- [ ] Export empty rundown
- [ ] Export rundown with single item
- [ ] Export rundown with multiple items
- [ ] Export rundown with nested groups
- [ ] Export rundown with all item types
- [ ] Import valid JSON file
- [ ] Import invalid JSON file (malformed)
- [ ] Import invalid JSON file (wrong structure)
- [ ] Import with merge option
- [ ] Import with replace option
- [ ] Import into different rundown
- [ ] Error handling for file read failures
- [ ] Error handling for network issues
- [ ] Large file handling (performance)
- [ ] Browser compatibility testing

## Future Enhancements

1. **Export Templates**: Pre-defined export formats
2. **Import Validation UI**: Preview and validate before importing
3. **Batch Operations**: Export/import multiple rundowns
4. **Cloud Storage**: Direct export to cloud services
5. **Version History**: Track export/import history
6. **Diff View**: Compare exported files
7. **Scheduled Exports**: Automatic backups
8. **Compression**: Support for compressed exports (.json.gz)

## Dependencies

- No new external dependencies required
- Uses existing Bridge API
- Uses standard browser APIs (File API, Blob API)

## Timeline Estimate

- **Phase 1** (Backend Commands): 2-3 hours
- **Phase 2** (File Utilities): 1-2 hours
- **Phase 3** (UI Components): 3-4 hours
- **Phase 4** (Error Handling): 2-3 hours
- **Phase 5** (Testing): 3-4 hours
- **Total**: ~12-16 hours

## Notes

- The implementation leverages existing `copyItems` and `pasteItems` functions, minimizing code duplication
- File operations use standard browser APIs, no server-side file handling needed
- The feature integrates seamlessly with existing UI patterns
- Export/import maintains full item hierarchy and relationships

