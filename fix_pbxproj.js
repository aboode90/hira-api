const xcode = require('xcode');
const fs = require('fs');
const path = require('path');

const projectPath = path.join(__dirname, '../ios/Runner.xcodeproj/project.pbxproj');
const myProj = xcode.project(projectPath);

myProj.parseSync();

// Add the entitlements file to the project
// xcode module handles adding it to PBXFileReference and PBXBuildFile if needed
myProj.addFile('Runner/Runner.entitlements', 'Runner');

// Update all build configurations with the entitlements setting
myProj.updateBuildProperty('CODE_SIGN_ENTITLEMENTS', '"Runner/Runner.entitlements"');

// Save the modified project
fs.writeFileSync(projectPath, myProj.writeSync());
console.log('Successfully updated project.pbxproj using xcode module.');
