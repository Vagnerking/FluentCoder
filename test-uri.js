const { Uri } = require("monaco-editor");

// Test what scheme a bare Windows path gets
const path1 = "C:\Users\Vagner\test.cs";
const uri1 = Uri.parse(path1);
console.log("Input:", path1);
console.log("Parsed URI:", uri1.toString());
console.log("Scheme:", uri1.scheme);
console.log("Path:", uri1.path);
console.log();

// Test what scheme a file:// URI gets
const path2 = "file:///C:/Users/Vagner/test.cs";
const uri2 = Uri.parse(path2);
console.log("Input:", path2);
console.log("Parsed URI:", uri2.toString());
console.log("Scheme:", uri2.scheme);
console.log("Path:", uri2.path);
