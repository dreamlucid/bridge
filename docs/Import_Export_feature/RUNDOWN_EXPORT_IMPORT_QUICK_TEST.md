# Quick Test Guide - Rundown Export/Import

## 5-Minute Smoke Test

Follow these steps for a quick verification that the feature works:

### Step 1: Start the Application
```bash
npm start
# or
npm run electron
```

### Step 2: Open Rundown Widget
- Open Bridge interface
- Ensure Rundown widget is visible

### Step 3: Quick Test Sequence

#### Test 1: Export Empty Rundown (30 seconds)
1. Ensure rundown is empty
2. Click **"Export"** button
3. ✅ Check: Success message appears
4. ✅ Check: File downloads (name like `rundown-export-[timestamp].json`)
5. ✅ Check: Open file, should contain: `[]`

#### Test 2: Add Items and Export (1 minute)
1. Right-click in rundown → **Add** → **Caspar** → **AMCP**
2. Add 2-3 more items (any type)
3. Click **"Export"** button
4. ✅ Check: Success message appears
5. ✅ Check: File downloads
6. ✅ Check: Open file, verify items are present

#### Test 3: Import with Merge (1 minute)
1. Click **"Import"** button
2. Select the file you just exported
3. In confirmation dialog, click **"Cancel"** (to merge)
4. ✅ Check: Success message shows item count
5. ✅ Check: Items appear in rundown (should have original + imported)

#### Test 4: Import with Replace (1 minute)
1. Click **"Import"** button
2. Select the same file again
3. In confirmation dialog, click **"OK"** (to replace)
4. ✅ Check: Success message appears
5. ✅ Check: Rundown now has only the imported items

#### Test 5: Error Handling (1 minute)
1. Create a text file with invalid JSON:
   ```
   { "invalid": json
   ```
2. Save as `test-invalid.json`
3. Click **"Import"** button
4. Try to select the invalid file
5. ✅ Check: Error message appears
6. ✅ Check: Error mentions "Invalid JSON"

### Expected Results Summary

✅ **All tests pass if:**
- Export button works and downloads files
- Import button opens file picker
- Valid files import successfully
- Invalid files show error messages
- Buttons show loading states ("Exporting...", "Importing...")
- Success/error messages are clear
- File input accepts only `.json` files

❌ **If any test fails:**
- Check browser console for errors
- Verify file permissions
- Check network connectivity (if server mode)
- Review error messages for details

## Common Issues

### File Not Downloading
- Check browser download settings
- Verify pop-up blocker isn't blocking
- Check browser console for errors

### Import Not Working
- Verify file is valid JSON
- Check file size (< 10MB)
- Ensure file contains array of items
- Verify items have `type` and `data` fields

### Buttons Not Responding
- Check if operation is in progress (button disabled)
- Refresh the page
- Check browser console for errors

## Next Steps

If the quick test passes, proceed with the comprehensive testing guide:
- See `RUNDOWN_EXPORT_IMPORT_TESTING.md` for full test suite


