# Rundown Export and Import Feature - Testing Guide

## Overview
This document provides a comprehensive testing guide for the rundown export and import feature. It includes manual testing scenarios, test data, and a checklist to ensure all functionality works correctly.

## Prerequisites

1. **Start the Bridge application**
   ```bash
   npm start
   # or for development
   npm run electron
   ```

2. **Open the Rundown widget** in the Bridge interface

3. **Prepare test data** - You'll need rundowns with various configurations

## Test Data Setup

### Test Scenario 1: Empty Rundown
- Create or use an empty rundown (no items)

### Test Scenario 2: Single Item Rundown
- Add one item to a rundown (e.g., an AMCP command item)

### Test Scenario 3: Multiple Items Rundown
- Add 3-5 items of different types to a rundown

### Test Scenario 4: Nested Groups Rundown
- Create a group item
- Add items inside the group
- Add items outside the group

### Test Scenario 5: Complex Rundown
- Mix of different item types (AMCP, groups, dividers, variables)
- Multiple levels of nesting
- 10+ items total

## Manual Testing Scenarios

### Phase 1: Export Testing

#### Test 1.1: Export Empty Rundown
**Steps:**
1. Ensure rundown is empty
2. Click "Export" button
3. Check for success message
4. Verify downloaded file exists
5. Open file and verify it contains: `[]`

**Expected Results:**
- ✅ Success message appears: "Rundown exported successfully!"
- ✅ File downloads with name like `rundown-export-[timestamp].json`
- ✅ File contains empty array: `[]`
- ✅ No errors occur

---

#### Test 1.2: Export Single Item Rundown
**Steps:**
1. Add one item to rundown (e.g., AMCP command)
2. Click "Export" button
3. Check for success message
4. Verify downloaded file
5. Open file and verify structure

**Expected Results:**
- ✅ Success message appears
- ✅ File downloads successfully
- ✅ File contains array with one item object
- ✅ Item has required fields: `id`, `type`, `data`
- ✅ Item structure matches original

---

#### Test 1.3: Export Multiple Items Rundown
**Steps:**
1. Add 3-5 items to rundown
2. Click "Export" button
3. Verify file download
4. Open file and verify all items are present

**Expected Results:**
- ✅ All items are exported
- ✅ Items maintain their order
- ✅ All items have correct structure
- ✅ No items are missing

---

#### Test 1.4: Export Nested Groups Rundown
**Steps:**
1. Create a group with items inside
2. Add items outside the group
3. Export the rundown
4. Verify file structure

**Expected Results:**
- ✅ Group items are exported
- ✅ Nested items maintain parent-child relationships
- ✅ `children` arrays are correctly populated
- ✅ `parent` fields are correctly set

---

#### Test 1.5: Export Button States
**Steps:**
1. Click "Export" button
2. Observe button during export
3. Check button state after export

**Expected Results:**
- ✅ Button shows "Exporting..." during operation
- ✅ Button is disabled during export
- ✅ Button returns to "Export" after completion
- ✅ Button is enabled after completion

---

#### Test 1.6: Export Error Handling
**Steps:**
1. (If possible) Simulate error condition
2. Attempt export
3. Check error message

**Expected Results:**
- ✅ Clear error message displayed
- ✅ Error message includes context
- ✅ Button returns to normal state
- ✅ No application crash

---

### Phase 2: Import Testing

#### Test 2.1: Import Valid JSON File
**Steps:**
1. Export a rundown (from Test 1.3)
2. Click "Import" button
3. Select the exported file
4. Choose "Merge" option (Cancel)
5. Verify items are added

**Expected Results:**
- ✅ File picker opens
- ✅ Only JSON files are selectable
- ✅ Confirmation dialog shows file name and item count
- ✅ Items are imported successfully
- ✅ Success message appears
- ✅ Items appear in rundown

---

#### Test 2.2: Import with Replace Option
**Steps:**
1. Have existing items in rundown
2. Export a different rundown
3. Click "Import"
4. Select exported file
5. Choose "Replace" option (OK)
6. Verify existing items are cleared

**Expected Results:**
- ✅ Confirmation dialog appears
- ✅ Existing items are removed
- ✅ New items are imported
- ✅ Success message shows correct count
- ✅ Rundown contains only imported items

---

#### Test 2.3: Import with Merge Option
**Steps:**
1. Have existing items in rundown
2. Export another rundown
3. Click "Import"
4. Select exported file
5. Choose "Merge" option (Cancel)
6. Verify items are added

**Expected Results:**
- ✅ Existing items remain
- ✅ New items are added
- ✅ All items are present
- ✅ No duplicates created
- ✅ Item order is maintained

---

#### Test 2.4: Import Invalid JSON File (Malformed)
**Steps:**
1. Create a text file with invalid JSON:
   ```json
   {
     "items": [
       "missing closing bracket"
   ```
2. Save as `.json` file
3. Click "Import"
4. Select invalid file
5. Check error message

**Expected Results:**
- ✅ Error message appears
- ✅ Error mentions "Invalid JSON"
- ✅ File input is reset
- ✅ No items are imported
- ✅ Rundown remains unchanged

---

#### Test 2.5: Import Invalid JSON File (Wrong Structure)
**Steps:**
1. Create JSON file with wrong structure:
   ```json
   {
     "wrong": "structure"
   }
   ```
2. Save as `.json` file
3. Click "Import"
4. Select file
5. Check error message

**Expected Results:**
- ✅ Error message appears
- ✅ Error mentions "must be an array"
- ✅ Clear error description
- ✅ No items are imported

---

#### Test 2.6: Import File with Missing Required Fields
**Steps:**
1. Create JSON file with invalid items:
   ```json
   [
     {
       "id": "test-1",
       "data": {}
     }
   ]
   ```
2. Save as `.json` file
3. Click "Import"
4. Select file
5. Check error message

**Expected Results:**
- ✅ Validation error appears
- ✅ Error mentions missing 'type' field
- ✅ Error includes item index
- ✅ No items are imported

---

#### Test 2.7: Import Empty Array
**Steps:**
1. Create JSON file: `[]`
2. Save as `.json` file
3. Click "Import"
4. Select file
5. Check error message

**Expected Results:**
- ✅ Error message: "Cannot import empty rundown"
- ✅ No items are imported
- ✅ Rundown remains unchanged

---

#### Test 2.8: Import File Too Large
**Steps:**
1. Create a JSON file larger than 10MB (if possible)
2. Click "Import"
3. Select large file
4. Check error message

**Expected Results:**
- ✅ Error message appears
- ✅ Error mentions file size limit
- ✅ Shows actual and maximum size
- ✅ No items are imported

---

#### Test 2.9: Import Empty File
**Steps:**
1. Create empty file
2. Save as `.json` file
3. Click "Import"
4. Select file
5. Check error message

**Expected Results:**
- ✅ Error message: "The selected file is empty"
- ✅ No items are imported

---

#### Test 2.10: Import Non-JSON File
**Steps:**
1. Create a text file: `test.txt`
2. Click "Import"
3. Try to select `.txt` file
4. Check if file is selectable

**Expected Results:**
- ✅ File picker filters to `.json` files only
- ✅ Non-JSON files are not selectable
- ✅ (If somehow selected) Error message appears

---

#### Test 2.11: Import Button States
**Steps:**
1. Click "Import" button
2. Select a file
3. Observe button during import
4. Check button state after import

**Expected Results:**
- ✅ Button shows "Importing..." during operation
- ✅ Button is disabled during import
- ✅ Export button is also disabled during import
- ✅ Button returns to "Import" after completion

---

#### Test 2.12: Import into Different Rundown
**Steps:**
1. Export from Rundown A
2. Switch to Rundown B
3. Import the file
4. Verify items appear in Rundown B

**Expected Results:**
- ✅ Items import to current rundown
- ✅ Items appear in correct rundown
- ✅ Original rundown unchanged

---

#### Test 2.13: Import File with Nested Structure
**Steps:**
1. Export a rundown with nested groups
2. Import the file into a new rundown
3. Verify hierarchy is preserved

**Expected Results:**
- ✅ Parent-child relationships maintained
- ✅ Groups contain correct items
- ✅ Nested structure is correct
- ✅ All items have new IDs (no collisions)

---

### Phase 3: Edge Cases and Error Handling

#### Test 3.1: Concurrent Operations Prevention
**Steps:**
1. Click "Export"
2. Immediately click "Import" (before export completes)
3. Check button states

**Expected Results:**
- ✅ Buttons are disabled during operations
- ✅ Only one operation can run at a time
- ✅ No race conditions

---

#### Test 3.2: Cancel File Selection
**Steps:**
1. Click "Import" button
2. Cancel file picker dialog
3. Check application state

**Expected Results:**
- ✅ No error occurs
- ✅ Application remains stable
- ✅ Can retry import

---

#### Test 3.3: Import Same File Twice
**Steps:**
1. Import a file
2. Import the same file again
3. Verify behavior

**Expected Results:**
- ✅ Items are imported again (if merge)
- ✅ Or items replace existing (if replace)
- ✅ No errors occur

---

#### Test 3.4: Export During Import
**Steps:**
1. Start import operation
2. Try to click Export during import
3. Check if export is prevented

**Expected Results:**
- ✅ Export button is disabled
- ✅ Cannot start export during import
- ✅ No errors occur

---

#### Test 3.5: Large Rundown Export
**Steps:**
1. Create rundown with 50+ items
2. Export the rundown
3. Verify file size and structure

**Expected Results:**
- ✅ Export completes successfully
- ✅ File contains all items
- ✅ Performance is acceptable (< 5 seconds)
- ✅ No memory issues

---

#### Test 3.6: Special Characters in Rundown Name
**Steps:**
1. Create rundown with special characters in name
2. Export the rundown
3. Check filename

**Expected Results:**
- ✅ Export succeeds
- ✅ Filename handles special characters
- ✅ File downloads correctly

---

### Phase 4: Data Integrity Testing

#### Test 4.1: Item Properties Preservation
**Steps:**
1. Create item with all properties (name, notes, color, etc.)
2. Export rundown
3. Import into new rundown
4. Compare item properties

**Expected Results:**
- ✅ All properties are preserved
- ✅ No data loss
- ✅ Values match original

---

#### Test 4.2: Item Order Preservation
**Steps:**
1. Create rundown with items in specific order
2. Export rundown
3. Import into new rundown
4. Verify item order

**Expected Results:**
- ✅ Items maintain original order
- ✅ Order matches export file
- ✅ No reordering occurs

---

#### Test 4.3: ID Collision Prevention
**Steps:**
1. Export rundown A
2. Import into rundown A (merge)
3. Verify no ID conflicts

**Expected Results:**
- ✅ New IDs are generated
- ✅ No ID collisions
- ✅ All items have unique IDs

---

#### Test 4.4: Variable References
**Steps:**
1. Create items with variable references
2. Export rundown
3. Import into new rundown
4. Verify variables work

**Expected Results:**
- ✅ Variable references preserved
- ✅ Variables still functional
- ✅ No broken references

---

## Test Data Files

### Valid Export File Example
```json
[
  {
    "id": "item-1",
    "type": "bridge.caspar.amcp",
    "data": {
      "name": "Test AMCP Command",
      "caspar": {
        "server": "group:0",
        "amcp": "PLAY 1-10 \"test.mp4\""
      }
    },
    "parent": null,
    "children": []
  },
  {
    "id": "item-2",
    "type": "bridge.types.group",
    "data": {
      "name": "Test Group"
    },
    "parent": null,
    "children": ["item-3"]
  },
  {
    "id": "item-3",
    "type": "bridge.caspar.amcp",
    "data": {
      "name": "Nested Item"
    },
    "parent": "item-2",
    "children": []
  }
]
```

### Invalid File Examples

**Missing Type:**
```json
[
  {
    "id": "item-1",
    "data": {}
  }
]
```

**Missing Data:**
```json
[
  {
    "id": "item-1",
    "type": "bridge.caspar.amcp"
  }
]
```

**Invalid Children:**
```json
[
  {
    "id": "item-1",
    "type": "bridge.types.group",
    "data": {},
    "children": "not-an-array"
  }
]
```

## Testing Checklist

### Export Functionality
- [ ] Export empty rundown
- [ ] Export rundown with single item
- [ ] Export rundown with multiple items
- [ ] Export rundown with nested groups
- [ ] Export rundown with all item types
- [ ] Export button shows loading state
- [ ] Export button disabled during operation
- [ ] Success message appears
- [ ] File downloads with correct name
- [ ] File contains valid JSON
- [ ] All items are exported
- [ ] Item order is preserved
- [ ] Item properties are preserved

### Import Functionality
- [ ] Import valid JSON file
- [ ] Import invalid JSON file (malformed)
- [ ] Import invalid JSON file (wrong structure)
- [ ] Import file with missing required fields
- [ ] Import empty array
- [ ] Import empty file
- [ ] Import file too large (>10MB)
- [ ] Import non-JSON file (filtered out)
- [ ] Import with merge option
- [ ] Import with replace option
- [ ] Import into different rundown
- [ ] Import button shows loading state
- [ ] Import button disabled during operation
- [ ] Confirmation dialog appears
- [ ] Confirmation shows file info
- [ ] Success message appears
- [ ] Error messages are clear
- [ ] File input resets after import

### Error Handling
- [ ] Export errors show clear messages
- [ ] Import errors show clear messages
- [ ] Validation errors include item index
- [ ] File size errors show actual size
- [ ] Application doesn't crash on errors
- [ ] Buttons return to normal state after errors

### Data Integrity
- [ ] Item properties preserved
- [ ] Item order preserved
- [ ] Parent-child relationships preserved
- [ ] No ID collisions
- [ ] Variable references work
- [ ] Nested structures maintained

### Edge Cases
- [ ] Concurrent operations prevented
- [ ] Cancel file selection works
- [ ] Import same file twice works
- [ ] Large rundowns export successfully
- [ ] Special characters in names handled

### Browser Compatibility
- [ ] Chrome/Edge
- [ ] Firefox
- [ ] Safari
- [ ] File download works
- [ ] File upload works

## Performance Testing

### Large File Handling
- [ ] Export 100+ items (< 5 seconds)
- [ ] Import 100+ items (< 10 seconds)
- [ ] No memory leaks
- [ ] UI remains responsive

### Stress Testing
- [ ] Export/Import cycle 10 times
- [ ] Multiple rapid exports
- [ ] Multiple rapid imports
- [ ] Application stability maintained

## Regression Testing

After implementing the feature, verify that existing functionality still works:
- [ ] Copy/paste still works
- [ ] Drag and drop still works
- [ ] Item creation still works
- [ ] Item deletion still works
- [ ] Item editing still works
- [ ] Play/stop functionality still works

## Reporting Issues

When reporting issues, include:
1. **Test scenario** - Which test case failed
2. **Steps to reproduce** - Exact steps taken
3. **Expected result** - What should happen
4. **Actual result** - What actually happened
5. **Error messages** - Any error messages shown
6. **Browser/OS** - Browser and OS version
7. **File size** - If relevant, size of exported/imported file
8. **Screenshots** - If applicable

## Quick Test Script

For a quick smoke test, run these 5 tests:

1. ✅ Export empty rundown → Verify `[]` in file
2. ✅ Add 3 items → Export → Verify 3 items in file
3. ✅ Import the file (merge) → Verify 6 items total
4. ✅ Import the file (replace) → Verify 3 items total
5. ✅ Try importing invalid JSON → Verify error message

If all 5 pass, the basic functionality is working!


