import * as monaco from "monaco-editor";

// When you parse a Windows path without file://, what scheme do you get?
const uri1 = monaco.Uri.parse("C:\Users\Vagner\test.cs");
console.log("Input: C:\Users\Vagner\test.cs");
console.log("Scheme:", uri1.scheme);
console.log("Full URI:", uri1.toString());
console.log();

const uri2 = monaco.Uri.parse("file:///C:/Users/Vagner/test.cs");
console.log("Input: file:///C:/Users/Vagner/test.cs");
console.log("Scheme:", uri2.scheme);
console.log("Full URI:", uri2.toString());
