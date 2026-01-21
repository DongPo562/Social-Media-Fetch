const ExcelJS = require('exceljs');
const fs = require('fs');

const HEADERS = [
    '编号', '标题', '媒体类型', '分类', '链接', '保存日期', 
    '是否下载', '本地地址', '音频状态', 'Notion状态', 'Notion链接'
];

// Helper to get column index by name from the header row
function getColumnIndex(sheet, headerName) {
    const headerRow = sheet.getRow(1);
    // iterate cells to find the match
    for (let i = 1; i <= headerRow.cellCount; i++) {
        const cellValue = headerRow.getCell(i).value;
        if (cellValue && cellValue.toString().trim() === headerName) {
            return i;
        }
    }
    return -1;
}

async function ensureExcelFile(filePath) {
    const workbook = new ExcelJS.Workbook();
    let fileExists = fs.existsSync(filePath);

    if (fileExists) {
        try {
            await workbook.xlsx.readFile(filePath);
        } catch (e) {
            console.error(`Failed to read existing Excel file: ${e.message}`);
            // If file is corrupted, maybe backup and create new? 
            // For now, let's throw or handle as if new if completely broken, 
            // but safer to throw to avoid data loss.
            throw e; 
        }

        let sheet = workbook.getWorksheet(1); // Get first sheet
        if (!sheet) {
            sheet = workbook.addWorksheet('Favorites');
            setupHeaders(sheet);
            await workbook.xlsx.writeFile(filePath);
            return;
        }

        // Check and update headers
        const headerRow = sheet.getRow(1);
        const existingHeaders = [];
        headerRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
            if (cell.value) existingHeaders.push(cell.value.toString().trim());
        });

        let headerChanged = false;
        HEADERS.forEach(h => {
            if (!existingHeaders.includes(h)) {
                // Add new column
                const nextCol = headerRow.cellCount + 1;
                const cell = headerRow.getCell(nextCol);
                cell.value = h;
                // Copy style from previous header cell if possible, or set default
                styleHeaderCell(cell);
                headerChanged = true;
                console.log(`Added missing column: ${h}`);
            }
        });

        if (headerChanged) {
            await workbook.xlsx.writeFile(filePath);
        }

    } else {
        const sheet = workbook.addWorksheet('Favorites');
        setupHeaders(sheet);
        
        // Freeze first row
        sheet.views = [
            { state: 'frozen', xSplit: 0, ySplit: 1 }
        ];

        await workbook.xlsx.writeFile(filePath);
    }
}

function setupHeaders(sheet) {
    const headerRow = sheet.getRow(1);
    HEADERS.forEach((h, index) => {
        const cell = headerRow.getCell(index + 1);
        cell.value = h;
        styleHeaderCell(cell);
        
        // Set default width
        const column = sheet.getColumn(index + 1);
        if (h === '标题' || h === '链接' || h === '本地地址' || h === 'Notion链接') {
            column.width = 50;
        } else {
            column.width = 15;
        }
    });
}

function styleHeaderCell(cell) {
    cell.font = { bold: true };
    cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFD3D3D3' } // Light Gray
    };
    cell.alignment = { horizontal: 'center' };
}

async function readExcelData(filePath) {
    if (!fs.existsSync(filePath)) return [];

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);
    const sheet = workbook.getWorksheet(1);
    if (!sheet) return [];

    const data = [];
    const headerRow = sheet.getRow(1);
    const headers = [];
    
    // Map column index to header name
    headerRow.eachCell((cell, colNumber) => {
        headers[colNumber] = cell.value ? cell.value.toString().trim() : '';
    });

    // Iterate rows starting from 2
    sheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return;

        // Check if row is empty (ignore formatting only rows)
        let hasData = false;
        const rowData = {};
        
        // We iterate based on known headers to ensure structure
        // But also check if row actually has values
        row.eachCell((cell) => {
            if (cell.value !== null && cell.value !== '') hasData = true;
        });

        if (hasData) {
            headers.forEach((h, colIndex) => {
                if (!h) return;
                let cell = row.getCell(colIndex);
                let val = cell.value;
                
                // Handle Hyperlinks: cell.value might be object { text: '...', hyperlink: '...' }
                if (val && typeof val === 'object' && val.text) {
                    val = val.text;
                }
                
                // Handle Rich Text (rare but possible)
                if (val && typeof val === 'object' && val.richText) {
                    val = val.richText.map(rt => rt.text).join('');
                }

                rowData[h] = val;
            });
            // Ensure ID is parsed as int if possible
            if (rowData['编号']) {
                // If it's a formula or other type, be careful. Assuming values.
                // It might be stored as string or number.
            }
            data.push(rowData);
        }
    });

    return data;
}

async function appendExcelData(filePath, newData) {
    if (newData.length === 0) return;

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);
    const sheet = workbook.getWorksheet(1);

    // Map headers to column indices
    const headerMap = {};
    const headerRow = sheet.getRow(1);
    headerRow.eachCell((cell, colNumber) => {
        const val = cell.value ? cell.value.toString().trim() : '';
        if (val) headerMap[val] = colNumber;
    });

    let lastRowNumber = sheet.lastRow ? sheet.lastRow.number : 1;
    // Safety check: if last row is just header
    if (lastRowNumber < 1) lastRowNumber = 1;

    let currentRow = lastRowNumber + 1;

    newData.forEach(item => {
        const row = sheet.getRow(currentRow);
        
        // Fill data based on headers
        Object.keys(item).forEach(key => {
            if (headerMap[key]) {
                const colIndex = headerMap[key];
                row.getCell(colIndex).value = item[key];
            }
        });
        
        // Optional: inherit style from previous row if exists
        // (Not strictly required by user, but nice to have. User said "New rows can have no special format or inherit")
        // We leave it clean to avoid complexity with borders etc.
        
        row.commit(); // Not strictly necessary but good practice
        currentRow++;
    });

    await workbook.xlsx.writeFile(filePath);
}

// Generic update function based on a unique key
async function updateExcelRow(filePath, uniqueKeyName, uniqueValue, updates) {
    const workbook = new ExcelJS.Workbook();
    // Use a retry mechanism for file locking
    let retries = 3;
    while (retries > 0) {
        try {
            await workbook.xlsx.readFile(filePath);
            break;
        } catch (e) {
            if (e.code === 'EBUSY' || e.message.includes('busy')) {
                retries--;
                console.log(`File is busy, retrying... (${retries})`);
                await new Promise(r => setTimeout(r, 1000));
            } else {
                throw e;
            }
        }
    }

    const sheet = workbook.getWorksheet(1);
    
    // Find Column Indices
    const headerMap = {};
    const headerRow = sheet.getRow(1);
    headerRow.eachCell((cell, colNumber) => {
        const val = cell.value ? cell.value.toString().trim() : '';
        if (val) headerMap[val] = colNumber;
    });

    const keyColIndex = headerMap[uniqueKeyName];
    if (!keyColIndex) {
        throw new Error(`Unique key column '${uniqueKeyName}' not found in Excel`);
    }

    // Find the row
    let targetRow = null;
    
    // Iterate rows. Note: huge files might be slow, but requirement is robustness.
    // Optimization: start from row 2
    sheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return;
        const cellValue = row.getCell(keyColIndex).value;
        
        // Handle potential hyperlink objects in key column (unlikely for Link column if stored as text, but possible)
        let val = cellValue;
        if (val && typeof val === 'object' && val.text) val = val.text;

        if (val == uniqueValue) { // Use loose equality for numbers/strings match
            targetRow = row;
        }
    });

    if (targetRow) {
        Object.keys(updates).forEach(key => {
            if (headerMap[key]) {
                targetRow.getCell(headerMap[key]).value = updates[key];
            }
        });
        await workbook.xlsx.writeFile(filePath);
        return true;
    } else {
        console.warn(`Row with ${uniqueKeyName}=${uniqueValue} not found.`);
        return false;
    }
}

module.exports = {
    HEADERS,
    ensureExcelFile,
    readExcelData,
    appendExcelData,
    updateExcelRow
};
